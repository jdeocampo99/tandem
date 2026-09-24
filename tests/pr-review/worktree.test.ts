import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { WorktreeLease } from "../../src/contracts.ts";
import { readReviewDiff } from "../../src/pr-review/diff.ts";
import { preparePrReviewRun, readRunFiles } from "../../src/pr-review/run.ts";
import type { PrReviewState } from "../../src/pr-review/state.ts";
import {
  isAncestor,
  prepareReviewWorktree,
  removeReviewWorktree,
} from "../../src/pr-review/worktree.ts";
import { fakeGh, ok, prView } from "./fake-gh.ts";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", "-C", cwd, ...args], cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(repo: string, file: string, text: string, message: string): Promise<string> {
  await mkdir(join(repo, file, ".."), { recursive: true });
  await writeFile(join(repo, file), text);
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/**
 * A GitHub stand-in: a bare origin with `main` and `refs/pull/7/head`, an author's clone that
 * pushes to both, and the reviewer's own checkout with work of its own on a feature branch.
 */
async function world() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tandem-pr-")));
  folders.push(base);
  const origin = join(base, "origin.git");
  const author = join(base, "author");
  const checkout = join(base, "mine");
  await runCommand({ argv: ["git", "init", "-q", "--bare", "-b", "main", origin], cwd: base });
  await runCommand({ argv: ["git", "clone", "-q", origin, author], cwd: base });
  await git(author, "checkout", "-q", "-b", "main");
  await mkdir(join(author, "src"), { recursive: true });
  await writeFile(join(author, "src/client.ts"), 'import { send } from "./upload";\n');
  const root = await commit(author, "src/upload.ts", "send(file);\n", "base");
  await git(author, "push", "-q", "origin", "main");
  await git(author, "checkout", "-q", "-b", "retry");
  await commit(author, "src/upload.ts", "retry(send, file);\n", "retry");
  await commit(author, "bun.lock", "lock v2\n", "lockfile");
  await git(author, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  await runCommand({ argv: ["git", "clone", "-q", origin, checkout], cwd: base });
  await git(checkout, "checkout", "-q", "-b", "my-work");
  await writeFile(join(checkout, "notes.txt"), "uncommitted work\n");
  return { base, origin, author, checkout, root, home: join(base, "home") };
}

async function landOnMain(author: string): Promise<void> {
  await git(author, "checkout", "-q", "main");
  await commit(author, "docs/changelog.md", "unrelated\n", "unrelated main change");
  await git(author, "push", "-q", "origin", "main");
  await git(author, "checkout", "-q", "retry");
}

test("reviews only the PR's own changes, never the user's checkout or later base changes", async () => {
  const w = await world();
  await landOnMain(w.author);
  const worktree = await prepareReviewWorktree(runCommand, {
    checkout: w.checkout,
    remote: "origin",
    ref: { repo: "acme/api", number: 7 },
    baseRef: "main",
    path: join(w.home, "wt"),
  });
  expect(worktree.head).toBe(await git(w.author, "rev-parse", "HEAD"));
  expect(worktree.mergeBase).toBe(w.root);

  const diff = await readReviewDiff(runCommand, worktree.path, worktree.mergeBase, worktree.head);
  expect(diff.files).toEqual(["src/upload.ts"]);
  expect(diff.skipped).toEqual(["bun.lock"]);
  expect(diff.patch).not.toContain("changelog");

  expect(await git(w.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("my-work");
  expect(await readFile(join(w.checkout, "notes.txt"), "utf8")).toBe("uncommitted work\n");
  expect(await git(w.checkout, "branch", "--list")).not.toContain("retry");

  await removeReviewWorktree(runCommand, worktree, { repo: "acme/api", number: 7 });
  await expect(stat(worktree.path)).rejects.toThrow();
  expect(await git(w.checkout, "for-each-ref", "refs/tandem")).toBe("");
  expect(await git(w.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("my-work");
  expect(await readFile(join(w.checkout, "notes.txt"), "utf8")).toBe("uncommitted work\n");
});

test("skips files the repository marks linguist-generated", async () => {
  const w = await world();
  await commit(w.author, ".gitattributes", "gen/** linguist-generated=true\n", "attrs");
  await commit(w.author, "gen/client.ts", "generated\n", "generated client");
  await git(w.author, "push", "-q", "-f", "origin", "HEAD:refs/pull/7/head");
  const worktree = await prepareReviewWorktree(runCommand, {
    checkout: w.checkout,
    remote: "origin",
    ref: { repo: "acme/api", number: 7 },
    baseRef: "main",
    path: join(w.home, "wt"),
  });
  const diff = await readReviewDiff(runCommand, worktree.path, worktree.mergeBase, worktree.head);
  expect(diff.files).toEqual([".gitattributes", "src/upload.ts"]);
  expect(diff.skipped).toEqual(["bun.lock", "gen/client.ts"]);
});

function stateFor(
  checkout: string,
  mode: PrReviewState["mode"],
  rounds: PrReviewState["rounds"] = [],
): PrReviewState {
  return {
    ref: { repo: "acme/api", number: 7 },
    url: "https://github.com/acme/api/pull/7",
    title: "Retry uploads",
    author: "sam",
    baseRef: "main",
    checkout,
    remote: "origin",
    lens: { kind: "full" },
    mode,
    rounds,
  };
}

function github() {
  return fakeGh({
    "gh pr view 7 --repo acme/api": ok(prView()),
    "gh api --paginate --slurp repos/acme/api/pulls/7/comments": ok([
      [
        {
          id: 11,
          user: { login: "me" },
          path: "src/upload.ts",
          line: 1,
          body: "Could we cap retries?",
        },
        { id: 12, in_reply_to_id: 11, user: { login: "sam" }, body: "Done" },
        { id: 13, user: { login: "lee" }, path: "src/upload.ts", line: 1, body: "LGTM" },
      ],
    ]),
    "gh api user": ok("me\n"),
  });
}

async function firstRun(w: Awaited<ReturnType<typeof world>>) {
  const { run } = github();
  const prepared = await preparePrReviewRun({
    run,
    clock: () => "2030-01-01T00:00:00.000Z",
    home: w.home,
    taskId: "task-1",
    holder: "s:task-1",
    generation: 0,
    state: stateFor(w.checkout, "review"),
  });
  return prepared;
}

function roundAt(head: string, from: string): PrReviewState["rounds"][number] {
  return {
    generation: 0,
    head,
    from,
    review: {
      head,
      intent: "x",
      readingOrder: [],
      concerns: [],
      comments: [],
      summaryComment: "",
      priorComments: [],
    },
    notes: [],
  };
}

test("a first run writes the diff, the context, and a lease at the PR head", async () => {
  const w = await world();
  const prepared = await firstRun(w);
  expect(prepared.from).toBe(w.root);
  expect(prepared.lease.baseHead).toBe(prepared.head);
  expect(prepared.lease.root).toBe(w.checkout);
  const context = await readFile(prepared.contextPath, "utf8");
  expect(context).toContain("Retries failed uploads twice.");
  expect(context).toContain("#3 Uploads fail on flaky wifi");
  expect(context).toContain("[commentId 11] me on src/upload.ts:1: Could we cap retries?");
  expect(context).toContain("reply from sam: Done");
  expect(context).toContain("## Other reviewers' threads");
  expect(context).toContain("lee on src/upload.ts:1: LGTM");
  expect(context).toContain("- bun.lock");
  expect(context).toMatch(/src\/upload\.ts \| +2 \+-/);
  expect(context).toContain("- src/client.ts");
  const numbered = await readFile(join(prepared.directory, "diff-numbered.patch"), "utf8");
  expect(numbered).toContain("     1 +retry(send, file);");
  const files = await readRunFiles(w.home, "task-1", 0);
  expect(files.head).toBe(prepared.head);
  expect(files.commentable.get("src/upload.ts")?.has(1)).toBe(true);
});

async function reRun(
  w: Awaited<ReturnType<typeof world>>,
  previous: Awaited<ReturnType<typeof firstRun>>,
) {
  const { run } = github();
  const lease: WorktreeLease = previous.lease;
  return preparePrReviewRun({
    run,
    clock: () => "2030-01-02T00:00:00.000Z",
    home: w.home,
    taskId: "task-1",
    holder: "s:task-1",
    generation: 1,
    state: stateFor(w.checkout, "re-review", [roundAt(previous.head, previous.from)]),
    existing: lease,
  });
}

test("a re-review after a normal push covers only the new commits", async () => {
  const w = await world();
  const first = await firstRun(w);
  const pushed = await commit(w.author, "src/upload.ts", "retry(send, file, 3);\n", "cap retries");
  await git(w.author, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  const second = await reRun(w, first);
  expect(second.head).toBe(pushed);
  expect(second.from).toBe(first.head);
  expect(await git(second.lease.path, "rev-parse", "HEAD")).toBe(pushed);
});

test("a re-review after a force-push reviews the whole PR again", async () => {
  const w = await world();
  const first = await firstRun(w);
  await git(w.author, "reset", "-q", "--hard", w.root);
  const rewritten = await commit(
    w.author,
    "src/upload.ts",
    "retryWithBackoff(send, file);\n",
    "rewrite",
  );
  await git(w.author, "push", "-q", "-f", "origin", "HEAD:refs/pull/7/head");
  const second = await reRun(w, first);
  expect(second.head).toBe(rewritten);
  expect(
    await isAncestor(
      runCommand,
      { checkout: w.checkout, path: second.lease.path, head: rewritten, mergeBase: w.root },
      first.head,
    ),
  ).toBe(false);
  expect(second.from).toBe(w.root);
});
