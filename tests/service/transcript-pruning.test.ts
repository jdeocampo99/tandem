import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../src/contracts.ts";
import { taskSessionDirectory } from "../../src/runtime/persistence.ts";
import { pruneTranscripts, transcriptsToPrune } from "../../src/service/transcript-pruning.ts";

const now = "2026-09-25T00:00:00.000Z";
const daysAgo = (days: number) =>
  new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();

function task(id: string, stage: TaskRecord["stage"], updatedAt: string): TaskRecord {
  return { id, stage, updatedAt } as TaskRecord;
}

test("only tasks finished more than 30 days ago lose their transcripts", () => {
  const tasks = [
    task("merged-old", "merged", daysAgo(31)),
    task("cancelled-at-cutoff", "cancelled", daysAgo(30)),
    task("completed-recent", "completed", daysAgo(29)),
    task("blocked-old", "blocked", daysAgo(90)),
    task("ready-old", "ready", daysAgo(90)),
  ];
  expect(transcriptsToPrune(tasks, now)).toEqual(["merged-old", "cancelled-at-cutoff"]);
});

test("pruning deletes each task's session folder and leaves every other folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prune-"));
  try {
    for (const id of ["old", "kept"]) {
      await mkdir(taskSessionDirectory(home, id), { recursive: true });
      await writeFile(join(taskSessionDirectory(home, id), "conversation.jsonl"), "{}\n");
    }
    await mkdir(join(home, "jobs", "old"), { recursive: true });

    await pruneTranscripts(home, ["old", "never-had-one"]);

    await expect(stat(taskSessionDirectory(home, "old"))).rejects.toThrow();
    expect((await stat(taskSessionDirectory(home, "kept"))).isDirectory()).toBe(true);
    expect((await stat(join(home, "jobs", "old"))).isDirectory()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
