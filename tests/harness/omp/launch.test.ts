import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCoordinatorArgv } from "../../../src/coordinator/launch.ts";
import { ompHarness } from "../../../src/harness/omp/launch.ts";

const SOURCE = fileURLToPath(new URL("../../../src/", import.meta.url));
const EXTENSION = join(SOURCE, "harness/omp/extension.ts");
const WORKER_EXTENSION = join(SOURCE, "harness/omp/worker-control.ts");
const CONFIG = join(SOURCE, "harness/omp/worker-config.yml");

test("the coordinator runs only read, ask and tandem with Tandem's extension and config", () => {
  expect(
    buildCoordinatorArgv({
      cwd: "/repo",
      model: { model: "openai-codex/gpt-6-astra", thinking: "high" },
      continueSession: true,
      sessionDirectory: "/home/coordinator-sessions/abc",
      prompt: "hello",
    }),
  ).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-6-astra",
    "--thinking",
    "high",
    "--config",
    CONFIG,
    "--no-extensions",
    "--extension",
    EXTENSION,
    "--tools",
    "read,ask,tandem",
    "--cwd",
    "/repo",
    "--no-prewalk",
    "--no-title",
    "--continue",
    "--session-dir",
    "/home/coordinator-sessions/abc",
    "hello",
  ]);
});

test("the coordinator leaves the model to OMP when none is given", () => {
  const argv = buildCoordinatorArgv({
    cwd: "/tandem",
    model: undefined,
    sessionDirectory: "/home/coordinator-sessions/abc",
  });
  expect(argv).not.toContain("--model");
  expect(argv).not.toContain("--thinking");
  expect(argv).not.toContain("--continue");
});

test("coordinator launch values that look like flags are refused", () => {
  expect(() =>
    buildCoordinatorArgv({
      cwd: "/repo",
      model: undefined,
      sessionDirectory: "/home/s",
      prompt: "--yolo",
    }),
  ).toThrow("prompt must not begin with '-'");
});

test("a pr-reviewer gets read-only tools plus bash and no saved conversation", () => {
  expect(
    ompHarness.command({
      agent: "pr-reviewer",
      cwd: "/worktree",
      model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      conversation: { kind: "none" },
      prompt: "Review it.",
    }),
  ).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "max",
    "--no-prewalk",
    "--no-rules",
    "--no-title",
    "--no-extensions",
    "--extension",
    WORKER_EXTENSION,
    "--no-session",
    "--config",
    CONFIG,
    "--cwd",
    "/worktree",
    "--tools",
    "read,grep,glob,submit_report,bash",
    "Review it.",
  ]);
});

test("a worker with a saved conversation resumes it", () => {
  const argv = ompHarness.command({
    agent: "implementer",
    cwd: "/worktree",
    model: { model: "m", thinking: "high" },
    conversation: { kind: "saved", directory: "/sessions/task-1", resume: true },
  });
  expect(argv.slice(11, 14)).toEqual(["--session-dir", "/sessions/task-1", "--continue"]);
  expect(argv).toContain("read,grep,glob,edit,write,bash,todo,submit_report");
});

test("a live command matches its record through bun launchers and --continue only", () => {
  const recorded = ["omp", "--cwd", "/repo", "--session-dir", "/s"];
  expect(ompHarness.sameCommand(["bun", "/x/omp", ...recorded.slice(1)], recorded)).toBe(true);
  expect(ompHarness.sameCommand([...recorded, "--continue"], recorded)).toBe(true);
  expect(ompHarness.sameCommand([...recorded, "--model", "other"], recorded)).toBe(false);
  expect(ompHarness.sameCommand(["node", ...recorded.slice(1)], recorded)).toBe(false);
});

test("an unrecorded coordinator is recognized from the old and the new extension path", async () => {
  const expected = { repoPath: "/repo", sessionDirectory: "/home/s" };
  for (const extension of [EXTENSION, join(SOURCE, "extension.ts")]) {
    await expect(
      ompHarness.matchUnrecordedCoordinator(
        ["omp", "--extension", extension, "--cwd", "/repo"],
        expected,
      ),
    ).resolves.toBe("match");
  }
  await expect(
    ompHarness.matchUnrecordedCoordinator(
      ["omp", "--extension", "/elsewhere/extension.ts", "--cwd", "/repo"],
      expected,
    ),
  ).resolves.toBe("no-match");
  await expect(
    ompHarness.matchUnrecordedCoordinator(["omp", "--extension", "--cwd", "/repo"], expected),
  ).resolves.toBe("unknown");
});

test("a recorded command names the session directory that identifies its process", () => {
  expect(ompHarness.processNeedle(["omp", "--session-dir", "/home/s"])).toBe(
    "--session-dir /home/s",
  );
  expect(ompHarness.processNeedle(["omp", "--cwd", "/repo"])).toBeUndefined();
});
