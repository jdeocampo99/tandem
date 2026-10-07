import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { CommandRequest } from "../../src/contracts.ts";
import { openProject, openProjectCommand } from "../../src/coordinator/open-project.ts";
import { listCoordinatorRecords, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { visitNativeProject } from "../../src/memory/native-visits.ts";
import { readProjectState } from "../../src/native/store.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { publishFixture } from "../native/view-files.ts";
import { viewsWith } from "../terminal-backend/views.ts";
import { saveCoordinator } from "./fake-workspace-order.ts";

const input = {
  repoPath: "/code/app",
  home: "/tandem-home",
  sessionId: "tandem",
  poolRoot: "/tandem-home/pool",
  tandemCheckout: "/tandem",
};

test("opening a project strips an ambient Herdr context before the child starts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-open-project-")));
  const checkout = join(root, "tandem");
  const repo = join(root, "app");
  const herdrEnvironment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "ambient-session",
    HERDR_SESSION_NAME: "ambient-name",
    HERDR_WORKSPACE_ID: "ambient-workspace",
    HERDR_PANE_ID: "ambient-pane",
  } as const;
  const herdrKeys = Object.keys(herdrEnvironment) as Array<keyof typeof herdrEnvironment>;
  try {
    await mkdir(join(checkout, "src"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(checkout, "src", "main.ts"),
      [
        "const keys = [",
        '  "HERDR_ENV",',
        '  "HERDR_SESSION",',
        '  "HERDR_SESSION_NAME",',
        '  "HERDR_WORKSPACE_ID",',
        '  "HERDR_PANE_ID",',
        "];",
        "console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(repo, ".keep"), "", "utf8");

    const request = openProjectCommand({
      ...input,
      repoPath: repo,
      tandemCheckout: checkout,
    });
    const result = await runCommand({ ...request, env: herdrEnvironment });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      Object.fromEntries(herdrKeys.map((key) => [key, null])),
    );
    expect(request.argv).toContain("--session");
    expect(request.argv).toContain(input.sessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    const opened = await openProject(run, terminalBackend(run, { terminal: "herdr" }), {
      ...input,
      repoPath: repo,
      home,
    });
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
  await expect(
    openProject(failing, terminalBackend(failing, { terminal: "herdr" }), input),
  ).rejects.toThrow("Tandem could not open /code/app: Herdr is not running");
  expect(requests).toHaveLength(1);
});

for (const outcome of ["opened", "unfocused", "ambiguous-window", "unavailable"] as const) {
  test(`Tern project open preserves its focus result when catch-up is ${outcome}`, async () => {
    const focused = outcome !== "unfocused";
    const warning =
      outcome === "ambiguous-window"
        ? "Native view needs a unique owning Tern window; supply --window when several are open"
        : outcome === "unavailable"
          ? "Tern could not open project catch-up"
          : undefined;
    const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-open-project-")));
    const home = join(root, "home");
    const repo = join(root, "api");
    try {
      await saveCoordinator(home, repo, "201");
      const saved = (await listCoordinatorRecords(home, input.sessionId))[0];
      if (!saved) throw new Error("Missing fixture coordinator");
      const record = {
        ...saved,
        endpoint: {
          ...saved.endpoint,
          terminal: "tern" as const,
          terminalSessionId: "17",
          paneId: "101",
          tabId: "201",
        },
      };
      await saveCoordinatorRecord(home, record);
      await publishFixture(home, repo, { changeSignature: "after" });
      await visitNativeProject(
        {
          home,
          project: repo,
          now: new Date(Date.now() - 2 * 3600000).toISOString(),
          signature: "before",
        },
        async () => {},
      );
      const visit = async () => JSON.stringify((await readProjectState(home, repo))?.visit);
      const previousVisit = await visit();
      const events: string[] = [];
      const run = async () => {
        events.push("launch --no-attach");
        return { code: 0, stdout: "", stderr: "" };
      };
      const base = terminalBackend(run, { terminal: "herdr" });
      const terminal = {
        ...base,
        name: "tern" as const,
        focusWorkspace: async () => {
          events.push("focus");
          return focused
            ? { focused: true as const }
            : { focused: false as const, code: 1, detail: "offline" };
        },
        views: viewsWith(base, {
          open: async (view) => {
            events.push(view.view.kind);
            expect(view.coordinator).toEqual(record.endpoint);
            expect(view.origin).toEqual({ paneId: "101", cwd: record.worktree.path });
            if (outcome === "ambiguous-window") throw new Error(warning);
            if (outcome === "unavailable") return { opened: false, warnings: [] };
            return { opened: true, warnings: [] };
          },
        }),
      };
      expect(await openProject(run, terminal, { ...input, home, repoPath: repo })).toEqual({
        focused,
        ...(warning === undefined
          ? {}
          : { warnings: [`Project opened, but catch-up is unavailable: ${warning}`] }),
      });
      expect(events).toEqual(
        focused ? ["launch --no-attach", "focus", "catchup"] : ["launch --no-attach", "focus"],
      );
      if (warning !== undefined) {
        expect(await visit()).toBe(previousVisit);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
