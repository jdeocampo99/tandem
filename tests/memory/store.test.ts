import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { centralConfigPath } from "../../src/config/repositories.ts";
import {
  archiveWorkstream,
  HANDOFFS_KEPT,
  listWorkstreams,
  memoryRoot,
  readWorkstream,
  saveWorkstream,
} from "../../src/memory/store.ts";

async function withTemporaryDirectory(operation: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tandem-memory-")));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function day(date: number): string {
  return `2030-01-${String(date).padStart(2, "0")}T12:00:00.000Z`;
}

test("notes live beside the project's settings file in the Tandem home, outside the repository", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repo = join(directory, "repo");
    const home = join(directory, "home");
    await mkdir(repo);
    const root = await memoryRoot(repo, home);
    expect(root).toBe(join(dirname(await centralConfigPath(repo, home)), "memory"));
    expect(root.startsWith(repo)).toBe(false);
  });
});

test("saving writes MEMORY.md, and listing reads every workstream by name", async () => {
  await withTemporaryDirectory(async (root) => {
    expect(await listWorkstreams(root)).toEqual([]);
    const result = await saveWorkstream(root, "TIA", { now: "Rolling out." }, day(3));
    expect(result.kind).toBe("saved");
    await saveWorkstream(root, "billing", { brief: "Goal: fewer refunds." }, day(3));
    // Something that is not a workstream is ignored.
    await mkdir(join(root, "Not A Name"));
    expect(await readFile(join(root, "tia", "MEMORY.md"), "utf8")).toBe(
      "# tia\n\n## Now\n\nRolling out.\n",
    );
    expect((await listWorkstreams(root)).map(({ memory }) => memory.name)).toEqual([
      "billing",
      "tia",
    ]);
    expect((await readWorkstream(root, "tia"))?.savedAt).toBe(day(3));
    expect(await readWorkstream(root, "onboarding")).toBeUndefined();
  });
});

test("a refused save leaves the file as it was", async () => {
  await withTemporaryDirectory(async (root) => {
    await saveWorkstream(root, "tia", { now: "Keep me." }, day(3));
    const refused = await saveWorkstream(root, "tia", { decisions: "x".repeat(20_000) }, day(4));
    expect(refused.kind).toBe("refused");
    expect((await readWorkstream(root, "tia"))?.memory.sections).toEqual({ now: "Keep me." });
  });
});

test("a new handoff is dated and archives the previous one, keeping the newest ten", async () => {
  await withTemporaryDirectory(async (root) => {
    for (let date = 1; date <= HANDOFFS_KEPT + 3; date += 1) {
      await saveWorkstream(root, "tia", { "last-handoff": `Handoff ${date}.` }, day(date));
    }
    const current = await readWorkstream(root, "tia");
    expect(current?.memory.sections["last-handoff"]).toBe("Saved 2030-01-13.\nHandoff 13.");
    const handoffs = join(root, "tia", "handoffs");
    const files = (await readdir(handoffs)).toSorted();
    expect(files).toHaveLength(HANDOFFS_KEPT);
    expect(files[0]).toBe("2030-01-03.md");
    expect(files.at(-1)).toBe("2030-01-12.md");
    expect(await readFile(join(handoffs, "2030-01-12.md"), "utf8")).toBe(
      "Saved 2030-01-12.\nHandoff 12.\n",
    );
  });
});

test("two handoffs on one day share that day's archive file", async () => {
  await withTemporaryDirectory(async (root) => {
    await saveWorkstream(root, "tia", { "last-handoff": "Morning." }, day(5));
    await saveWorkstream(root, "tia", { "last-handoff": "Noon." }, day(5));
    await saveWorkstream(root, "tia", { "last-handoff": "Evening." }, day(5));
    expect(await readFile(join(root, "tia", "handoffs", "2030-01-05.md"), "utf8")).toBe(
      "Saved 2030-01-05.\nMorning.\n\n---\n\nSaved 2030-01-05.\nNoon.\n",
    );
  });
});

test("a finished workstream is archived with its notes and dropped from the list", async () => {
  await withTemporaryDirectory(async (root) => {
    await saveWorkstream(root, "tia", { now: "Done." }, day(3));
    await archiveWorkstream(root, "tia", day(4));
    await saveWorkstream(root, "tia", { now: "Again." }, day(4));
    const second = await archiveWorkstream(root, "tia", day(4));
    expect(second).toBe(join(root, "_archive", "tia-2030-01-04-2"));
    expect(await listWorkstreams(root)).toEqual([]);
    expect(await readFile(join(root, "_archive", "tia-2030-01-04", "MEMORY.md"), "utf8")).toContain(
      "Done.",
    );
    await expect(archiveWorkstream(root, "billing", day(4))).rejects.toThrow("no workstream");
  });
});

test("a hand-edited file is read as the user left it", async () => {
  await withTemporaryDirectory(async (root) => {
    await mkdir(join(root, "tia"), { recursive: true });
    await writeFile(join(root, "tia", "MEMORY.md"), "# tia\n\n## Now\n\nEdited by hand.\n");
    expect((await readWorkstream(root, "tia"))?.memory.sections.now).toBe("Edited by hand.");
  });
});
