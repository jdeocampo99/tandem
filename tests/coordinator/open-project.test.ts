import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { CommandRequest } from "../../src/contracts.ts";
import { openProject, openProjectCommand } from "../../src/coordinator/open-project.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { saveCoordinator } from "./fake-workspace-order.ts";

const input = {
  repoPath: "/code/app",
  home: "/tandem-home",
  sessionId: "tandem",
  poolRoot: "/tandem-home/pool",
  tandemCheckout: "/tandem",
};

test("opening a project runs the front door without this coordinator's pane or checkout", () => {
  expect(openProjectCommand(input)).toEqual({
    argv: [
      "env",
      "-u",
      "TANDEM_REPO",
      "-u",
      "TANDEM_SOURCE_REPO",
      "-u",
      "TANDEM_PARENT_WORKSPACE",
      "-u",
      "HERDR_PANE_ID",
      "-u",
      "HERDR_WORKSPACE_ID",
      "bun",
      "/tandem/src/main.ts",
      "/code/app",
      "--home",
      "/tandem-home",
      "--session",
      "tandem",
      "--pool-root",
      "/tandem-home/pool",
      "--no-attach",
    ],
    cwd: "/code/app",
  });
});

test("an opened project's workspace is brought forward", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-open-project-")));
  try {
    const home = join(root, "home");
    const repo = join(root, "api");
    const ran: string[][] = [];
    const run = async (request: CommandRequest) => {
      ran.push([...request.argv]);
      if (request.argv[0] === "env") await saveCoordinator(home, repo, "w-api");
      return { code: 0, stdout: "", stderr: "" };
    };
    const opened = await openProject(run, { ...input, repoPath: repo, home });
    expect(opened).toEqual({ focused: true });
    expect(ran.at(-1)).toEqual(["herdr", "--session", "tandem", "workspace", "focus", "w-api"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed open names the project and the front door's reason", async () => {
  const requests: CommandRequest[] = [];
  const failing = async (request: CommandRequest) => {
    requests.push(request);
    return { code: 1, stdout: "", stderr: "tandem: Herdr is not running\n" };
  };
  await expect(openProject(failing, input)).rejects.toThrow(
    "Tandem could not open /code/app: Herdr is not running",
  );
  expect(requests).toHaveLength(1);
});

test("the service refuses to open a project whose settings are not saved", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-open-project-")));
  const repo = join(root, "app");
  try {
    await runCommand({ argv: ["git", "init", repo], cwd: root });
    const launched: CommandRequest[] = [];
    const service = createTandemService({
      home: join(root, "home"),
      sessionId: "tandem",
      poolRoot: join(root, "pool"),
      run: async (request) => {
        if (request.argv[0] === "env") launched.push(request);
        return runCommand(request);
      },
    });
    try {
      await expect(service.openProject(repo)).rejects.toThrow("has no saved Tandem settings yet");
      expect(launched).toHaveLength(0);
    } finally {
      await service.shutdown();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
