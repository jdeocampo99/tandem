import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityTool,
  nextWorkerActivity,
  readWorkerActivity,
  workerActivityPath,
  writeWorkerActivity,
} from "../../src/workers/worker-activity.ts";

const START = "2030-01-01T00:00:00.000Z";
const LATER = "2030-01-01T00:00:05.000Z";

function targetOf(tool: Omit<ActivityTool, "name">): string | undefined {
  return nextWorkerActivity({}, { phase: "tool", tool: { name: "bash", ...tool } }, START).activity
    .toolTarget;
}

test("the activity changes on a new tool, target, or to-do list, and keeps a tool's start", () => {
  const bun = { name: "bash", command: "bun test" };
  const first = nextWorkerActivity({}, { phase: "tool", tool: bun }, START);
  expect(first).toEqual({
    activity: { tool: "bash", toolTarget: "bun test", toolStartedAt: START },
    changed: true,
  });
  expect(nextWorkerActivity(first.activity, { phase: "tool", tool: bun }, LATER)).toEqual({
    activity: first.activity,
    changed: false,
  });
  const lint = { name: "bash", command: "bun run lint" };
  expect(nextWorkerActivity(first.activity, { phase: "tool", tool: lint }, LATER).activity).toEqual(
    { tool: "bash", toolTarget: "bun run lint", toolStartedAt: LATER },
  );

  const todos = [{ content: "Write the test", status: "in_progress" }];
  const ended = nextWorkerActivity(first.activity, { phase: "idle", tool: bun, todos }, LATER);
  expect(ended).toEqual({ activity: { todos }, changed: true });
  expect(nextWorkerActivity(ended.activity, { phase: "model" }, LATER)).toEqual({
    activity: { todos },
    changed: false,
  });
});

test("a command keeps only its leading plain words, so flags, assignments, and URLs stay out", () => {
  expect(targetOf({ command: "bun test tests/cache" })).toBe("bun test tests/cache");
  expect(targetOf({ command: 'curl -H "Authorization: Bearer abc" https://x.test' })).toBe("curl");
  expect(targetOf({ command: "TOKEN=abc deploy" })).toBeUndefined();
  expect(targetOf({ command: "git push https://user:pw@github.com/a/b" })).toBe("git push");
  expect(targetOf({ command: "echo 'secret'" })).toBe("echo");
  expect(targetOf({ command: "ssh me@host" })).toBe("ssh");
  expect(targetOf({ command: "bun test\n  --watch" })).toBe("bun test");
});

test("a URL keeps its host and path, without credentials, query, or fragment", () => {
  expect(targetOf({ path: "https://user:pw@api.test/v1/items?token=abc#frag" })).toBe(
    "api.test/v1/items",
  );
});

test("a blank path falls through to the command", () => {
  expect(targetOf({ path: "  ", command: "bun test" })).toBe("bun test");
});

test("long targets and to-dos are cut by code points, a path keeping its end", () => {
  const path = `${"😀/".repeat(80)}session.ts`;
  const target = targetOf({ path }) ?? "";
  expect(Array.from(target)).toHaveLength(120);
  expect(target.startsWith("…")).toBe(true);
  expect(target.endsWith("/session.ts")).toBe(true);
  expect(target.isWellFormed()).toBe(true);

  const command = targetOf({ command: `echo ${"😀".repeat(200)}` }) ?? "";
  expect(Array.from(command)).toHaveLength(120);
  expect(command.endsWith("…")).toBe(true);
  expect(command.isWellFormed()).toBe(true);

  const todos = Array.from({ length: 60 }, (_, index) => ({
    content: `step ${index}\nsecond line`,
    status: "pending",
  }));
  const shown = nextWorkerActivity({}, { phase: "idle", todos }, START).activity.todos;
  expect(shown).toHaveLength(50);
  expect(shown?.[0]).toEqual({ content: "step 0 second line", status: "pending" });
});

test("the activity file round-trips, and a missing or broken one reads as no activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-activity-"));
  try {
    const receiptPath = join(root, "communication.json");
    expect(workerActivityPath(receiptPath)).toBe(join(root, "activity.json"));
    expect(await readWorkerActivity(receiptPath)).toBeUndefined();
    const activity = {
      tool: "edit",
      toolTarget: "src/a.ts",
      toolStartedAt: START,
      todos: [{ content: "Write the test", status: "pending" }],
    };
    await writeWorkerActivity(receiptPath, activity);
    expect(await readWorkerActivity(receiptPath)).toEqual(activity);
    await writeFile(workerActivityPath(receiptPath), "{not json", { mode: 0o600 });
    expect(await readWorkerActivity(receiptPath)).toBeUndefined();
    await writeFile(
      workerActivityPath(receiptPath),
      JSON.stringify({ tool: 3, toolTarget: "x", todos: [{ content: 1 }], extra: true }),
      { mode: 0o600 },
    );
    expect(await readWorkerActivity(receiptPath)).toEqual({ toolTarget: "x", todos: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
