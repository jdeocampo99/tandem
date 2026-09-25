import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoard, runLiveBoard } from "../../src/board/read.ts";
import { renderBoard } from "../../src/board/view.ts";
import { withPrWatches } from "../../src/pr-watch/store.ts";
import { StoreLockTimeoutError } from "../../src/tasks/store-errors.ts";

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
      "Tandem · checked 40s ago\n\nNeeds you\n🙋 app #409 ❌ failing e2e failed twice\n",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
