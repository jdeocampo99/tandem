import type { CommandRunner, TaskRecord, WorktreeLease } from "../contracts.ts";
import { observeScoutCheckout } from "./scout-cleanup.ts";

/** A git ref that may already carry a task's commits, named the way a person would recognise it. */
export type ContainerRef = Readonly<{ readonly ref: string; readonly label: string }>;

/** Proof, from git, that another piece of work already holds every commit of a task's worktree. */
export type SupersededProof = Readonly<{
  readonly head: string;
  readonly ref: string;
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

/** Only exit 0 proves ancestry; "not an ancestor" and "unknown ref" both mean not contained. */
async function isAncestor(
  run: CommandRunner,
  repo: string,
  commit: string,
  ref: string,
): Promise<boolean> {
  const result = await run({
    argv: ["git", "-C", repo, "merge-base", "--is-ancestor", commit, ref],
    cwd: repo,
  });
  return result.code === 0;
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

/**
 * Reads, without changing anything, whether a terminal implementation worktree can be returned
 * with nothing lost: already in the main checkout, fully contained in other work, or neither.
 */
export async function observeWorktreeContainment(
  run: CommandRunner,
  repo: string,
  lease: WorktreeLease,
  containers: readonly ContainerRef[],
): Promise<WorktreeContainment> {
  const checkout = await cleanHead(run, lease);
  if ("reason" in checkout) return { kind: "kept", reason: checkout.reason };
  if (await isAncestor(run, repo, checkout.head, "HEAD")) return { kind: "landed" };
  for (const container of containers) {
    if (await isAncestor(run, repo, checkout.head, container.ref)) {
      return { kind: "superseded", proof: { head: checkout.head, ...container } };
    }
  }
  return { kind: "kept", reason: "has commits not in main or any other work" };
}

/**
 * Re-proves a superseded worktree immediately before it is returned: still clean, still on its
 * branch at the same commit, and that commit still contained in the same ref. Returns why not.
 */
export async function recheckSuperseded(
  run: CommandRunner,
  repo: string,
  lease: WorktreeLease,
  proof: SupersededProof,
): Promise<string | undefined> {
  const checkout = await cleanHead(run, lease);
  if ("reason" in checkout) return `the worktree ${checkout.reason}`;
  if (checkout.head !== proof.head) return "the worktree has new commits since it was checked";
  if (!(await isAncestor(run, repo, proof.head, proof.ref))) {
    return `${proof.label} no longer contains the worktree's commits`;
  }
  return undefined;
}
