import type { CommandRunner, TaskRecord, WorktreeLease } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import { observeScoutCheckout } from "./scout-checkout.ts";

/** A git ref that may already carry a task's commits, named the way a person would recognise it. */
export type ContainerRef = Readonly<{ readonly ref: string; readonly label: string }>;

/** Proof, from git, that the commits of a worktree at `head` are all carried by other work. */
export type SupersededProof = Readonly<{
  readonly head: string;
  /** Where the work is, e.g. `task e2c0fbb5`, `task e2c0fbb5 (same changes, rebased)`, `main`. */
  readonly label: string;
}>;

/** What returning a terminal implementation task's worktree would lose, if anything. */
export type WorktreeContainment =
  | Readonly<{ readonly kind: "landed" }>
  | Readonly<{ readonly kind: "superseded"; readonly proof: SupersededProof }>
  | Readonly<{ readonly kind: "kept"; readonly reason: string }>;

/** A worktree some other task holds, so its branch is a candidate container. */
export type OtherTaskWork = Readonly<{
  readonly task: Pick<TaskRecord, "id" | "repoPath" | "pullRequest">;
  readonly branch: string | undefined;
}>;

const OBJECT_ID = /^[0-9a-f]{40}$/u;
const MAIN_LABEL = "main";
/** The repository's own line of work: the primary checkout and the remote's default branch. */
const MAIN_REFS = [
  "HEAD",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
];

/** Every task's branch, from its runtime lease when it has one, else from the task record. */
export function otherTaskWork(
  tasks: readonly TaskRecord[],
  state: RuntimeState,
): readonly OtherTaskWork[] {
  return tasks.map((task) => ({
    task,
    branch: (taskRuntime(state, task.id)?.worktree ?? task.worktree)?.branch,
  }));
}

/**
 * Lists every ref in the task's repository that could already carry its commits: each recorded
 * pull request head (draft, open, or merged, on any task; never a closed one) and every other
 * task's branch. The task's own branch never counts: it is the very thing being checked.
 */
export function containerRefs(
  task: Pick<TaskRecord, "id" | "repoPath">,
  ownBranch: string,
  others: readonly OtherTaskWork[],
): readonly ContainerRef[] {
  const own = `refs/heads/${ownBranch}`;
  const refs: ContainerRef[] = [];
  const add = (ref: string, label: string) => {
    if (ref !== own && !refs.some((existing) => existing.ref === ref)) refs.push({ ref, label });
  };
  const sameRepo = others.filter((other) => other.task.repoPath === task.repoPath);
  for (const other of sameRepo) {
    const pr = other.task.pullRequest;
    if (pr === undefined || pr.state === "closed") continue;
    const label = `PR #${pr.number}`;
    if (OBJECT_ID.test(pr.head)) add(pr.head, label);
    else {
      add(`refs/heads/${pr.head}`, label);
      add(`refs/remotes/origin/${pr.head}`, label);
    }
  }
  for (const other of sameRepo) {
    if (other.task.id === task.id || other.branch === undefined) continue;
    add(`refs/heads/${other.branch}`, `task ${other.task.id.slice(0, 8)}`);
  }
  return refs;
}

async function git(
  run: CommandRunner,
  repo: string,
  args: readonly string[],
): Promise<readonly string[] | undefined> {
  const result = await run({ argv: ["git", "-C", repo, ...args], cwd: repo });
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** Resolves each ref to its commit once, dropping refs this repository does not have. */
async function resolveRefs(
  run: CommandRunner,
  repo: string,
  refs: readonly ContainerRef[],
): Promise<readonly ContainerRef[]> {
  const resolved: ContainerRef[] = [];
  for (const { ref, label } of refs) {
    const found = await git(run, repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const commit = found?.[0];
    if (commit !== undefined && OBJECT_ID.test(commit)) resolved.push({ ref: commit, label });
  }
  return resolved;
}

async function cleanHead(
  run: CommandRunner,
  lease: WorktreeLease,
): Promise<Readonly<{ head: string }> | Readonly<{ reason: string }>> {
  const checkout = await observeScoutCheckout(run, lease.path);
  if (checkout.status === "missing") return { reason: "folder is missing" };
  if (checkout.status === "unreadable") return { reason: "could not be read" };
  if (checkout.dirty) return { reason: "has uncommitted changes" };
  if (checkout.unmerged) return { reason: "has unmerged files" };
  if (checkout.branch !== lease.branch) return { reason: "is not on its task branch" };
  return { head: checkout.head };
}

type Coverage = Readonly<{ readonly label: string; readonly rebased: boolean }>;

/**
 * Decides, from git alone, whether every commit at `head` that main lacks is carried elsewhere.
 *
 * A commit is carried when it is an ancestor of some other work ref or of main, or when
 * `git rev-list --cherry-mark` finds a patch-equivalent commit there (a rebased or copied change).
 * A merge commit is also carried when all its parents are. Refs are tried in order, other work
 * before main, so the label names that work.
 */
async function containment(
  run: CommandRunner,
  repo: string,
  head: string,
  containers: readonly ContainerRef[],
): Promise<WorktreeContainment> {
  const main = await resolveRefs(
    run,
    repo,
    MAIN_REFS.map((ref) => ({ ref, label: MAIN_LABEL })),
  );
  if (main.length === 0) return { kind: "kept", reason: "the main branch could not be read" };
  const lines = await git(run, repo, [
    "rev-list",
    "--parents",
    head,
    "--not",
    ...main.map((entry) => entry.ref),
  ]);
  if (lines === undefined) return { kind: "kept", reason: "its commits could not be listed" };
  const commits = lines.map((line) => {
    const [commit = "", ...parents] = line.split(" ");
    return { commit, parents };
  });
  const coverage = new Map<string, Coverage>();
  for (const ref of [...(await resolveRefs(run, repo, containers)), ...main]) {
    if (commits.every(({ commit }) => coverage.has(commit))) break;
    const marked = await git(run, repo, [
      "rev-list",
      "--cherry-mark",
      "--right-only",
      `${ref.ref}...${head}`,
    ]);
    if (marked === undefined) continue;
    const missing = new Set(marked.map((line) => line.slice(1)));
    const equivalent = new Set(
      marked.filter((line) => line.startsWith("=")).map((line) => line.slice(1)),
    );
    for (const { commit } of commits) {
      if (coverage.has(commit)) continue;
      if (!missing.has(commit)) coverage.set(commit, { label: ref.label, rebased: false });
      else if (equivalent.has(commit)) coverage.set(commit, { label: ref.label, rebased: true });
    }
  }
  const listed = new Set(commits.map(({ commit }) => commit));
  const carried = new Set<string>();
  // rev-list prints newest first; parents must be decided before the merges that join them.
  for (const { commit, parents } of [...commits].reverse()) {
    const byParents =
      parents.length > 1 && parents.every((parent) => !listed.has(parent) || carried.has(parent));
    if (coverage.has(commit) || byParents) carried.add(commit);
  }
  const lost = commits.filter(({ commit }) => !carried.has(commit)).length;
  if (lost > 0) {
    return {
      kind: "kept",
      reason: `has ${lost} commit${lost === 1 ? "" : "s"} not in main or any other work`,
    };
  }
  const used = [...coverage.values()].filter((entry) => entry.label !== MAIN_LABEL);
  const labels = [...new Set(used.map((entry) => entry.label))];
  const rebased = used.some((entry) => entry.rebased);
  const label =
    labels.length === 0
      ? MAIN_LABEL
      : `${labels.join(" and ")}${rebased ? " (same changes, rebased)" : ""}`;
  return { kind: "superseded", proof: { head, label } };
}

/**
 * Reads, without changing anything, whether a terminal implementation worktree can be returned
 * with nothing lost: already in the main checkout, fully carried by other work, or neither.
 */
export async function observeWorktreeContainment(
  run: CommandRunner,
  repo: string,
  lease: WorktreeLease,
  containers: readonly ContainerRef[],
): Promise<WorktreeContainment> {
  const checkout = await cleanHead(run, lease);
  if ("reason" in checkout) return { kind: "kept", reason: checkout.reason };
  const landed = await run({
    argv: ["git", "-C", repo, "merge-base", "--is-ancestor", checkout.head, "HEAD"],
    cwd: repo,
  });
  if (landed.code === 0) return { kind: "landed" };
  return await containment(run, repo, checkout.head, containers);
}

/**
 * Re-proves a superseded worktree immediately before it is returned: still clean, on its branch at
 * the same commit, and every commit still carried by other work. Returns why not.
 */
export async function recheckSuperseded(
  run: CommandRunner,
  repo: string,
  lease: WorktreeLease,
  proof: SupersededProof,
  containers: readonly ContainerRef[],
): Promise<string | undefined> {
  const checkout = await cleanHead(run, lease);
  if ("reason" in checkout) return `the worktree ${checkout.reason}`;
  if (checkout.head !== proof.head) return "the worktree has new commits since it was checked";
  const now = await containment(run, repo, checkout.head, containers);
  return now.kind === "kept" ? `the worktree ${now.reason}` : undefined;
}
