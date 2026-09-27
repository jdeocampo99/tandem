import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoard, runLiveBoard } from "../../src/board/read.ts";
import { renderBoard } from "../../src/board/view.ts";
import { withPrWatches } from "../../src/pr-watch/store.ts";
import { StoreLockTimeoutError } from "../../src/tasks/store-errors.ts";
import { seedScenarioTask, withScenario } from "../evals/scenario.ts";

test("the live board redraws only when its text changed, and skips a round the state is locked", async () => {
  const frames = ["a", "a", "locked", "b", "b"];
  const drawn: string[] = [];
  const sleeps: number[] = [];
  const stopped = runLiveBoard({
    render: async () => {
      const frame = frames.shift();
      if (frame === "locked") throw new StoreLockTimeoutError("/home/.state.lock", 5_000);
      return frame ?? "b";
    },
    draw: (text) => drawn.push(text),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (frames.length === 0) throw new Error("interrupted");
    },
  });
  await expect(stopped).rejects.toThrow("interrupted");
  expect(drawn).toEqual(["a", "b"]);
  expect(sleeps).toEqual(Array(5).fill(2_000));
});

test("the live board stops drawing once it is closed, even mid-sleep", async () => {
  const drawn: string[] = [];
  let close = (): void => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let rounds = 0;
  await runLiveBoard({
    render: async () => {
      rounds += 1;
      return `frame ${rounds}`;
    },
    draw: (text) => {
      drawn.push(text);
      if (rounds === 2) close();
    },
    // Never wakes on its own after the first round: only closing ends the wait.
    sleep: (_ms, signal) =>
      rounds === 1
        ? Promise.resolve()
        : new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
    closed,
  });
  expect(drawn).toEqual(["frame 1", "frame 2"]);
});

test("the board reads pull requests from what PR watch last saved", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-board-"));
  try {
    await withPrWatches(home, ({ put, putPoll }) => {
      put({
        ref: { repo: "acme/app", number: 409 },
        origin: "user",
        startedAt: "2030-01-01T00:00:00.000Z",
        log: [],
        row: { color: "red", status: "❌ failing", note: "e2e failed twice" },
      });
      putPoll({ readAt: "2030-01-01T11:59:20.000Z" });
    });
    const view = await readBoard(home, () => "2030-01-01T12:00:00.000Z");
    expect(renderBoard(view)).toBe(
      [
        "## Tandem status",
        "",
        "**Projects:** none yet · **PRs checked:** 40s ago",
        "",
        "### 🙋 Needs you · 1",
        "- 🔴 **app** · **acme/app#409** — e2e failed twice",
        "",
        "_Live view: `prefix+t` in Herdr, or `tandem status --watch`._",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a task the timeline shows finishing this week adds the weekly line", async () => {
  await withScenario({}, async (world) => {
    const reviewing = await seedScenarioTask(world, { kind: "implementation", stage: "reviewing" });
    await world.store.update(reviewing.id, reviewing.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      stage: "completed",
    }));
    const view = await readBoard(world.home, world.clock);
    expect(renderBoard(view)).toContain(
      "\n### 📈 This week\n1 done · 1 of 1 passed review first time · $0.00\n\n_Live view:",
    );
  });
});
