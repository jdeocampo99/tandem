import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import { patchFiles, readPageSources } from "../../src/pr-review/page-input.ts";

let repo: string;

async function git(...args: string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", "-C", repo, ...args], cwd: repo });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function commitAll(message: string): Promise<string> {
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return (await git("rev-parse", "HEAD")).trim();
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "tandem-page-input-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("sources hold each changed file at the head and at the diff's start, absent where missing", async () => {
  await writeFile(join(repo, "kept.ts"), "one\n");
  await writeFile(join(repo, "gone.ts"), "bye\n");
  await writeFile(join(repo, "old-name.ts"), "same body\nfor rename\ndetection\n");
  const from = await commitAll("base");
  await writeFile(join(repo, "kept.ts"), "one\ntwo\n");
  await rm(join(repo, "gone.ts"));
  await writeFile(join(repo, "added.ts"), "new\n");
  await git("mv", "old-name.ts", "new-name.ts");
  await writeFile(join(repo, "new-name.ts"), "same body\nfor rename\ndetection\nplus one\n");
  const head = await commitAll("change");
  const patch = await git("diff", "-M", from, head);

  expect(await readPageSources(runCommand, repo, { head, from }, patch)).toEqual({
    "added.ts": { head: "new\n" },
    "new-name.ts": {
      head: "same body\nfor rename\ndetection\nplus one\n",
      base: "same body\nfor rename\ndetection\n",
    },
    "gone.ts": { base: "bye\n" },
    "kept.ts": { head: "one\ntwo\n", base: "one\n" },
  });
});

test("a removed line that starts with dashes is not mistaken for a file header", () => {
  const patch = [
    "diff --git a/q.sql b/q.sql",
    "--- a/q.sql",
    "+++ b/q.sql",
    "@@ -1,2 +1,1 @@",
    "--- a comment",
    "+++ added text",
    " select 1;",
  ].join("\n");
  expect(patchFiles(patch)).toEqual([{ oldPath: "q.sql", newPath: "q.sql" }]);
});
