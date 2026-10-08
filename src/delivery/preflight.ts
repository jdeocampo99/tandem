import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import { readGitText } from "../adapters/primitives.ts";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState } from "../runtime/persistence.ts";
import { describeError, isRecord } from "../service/records.ts";
import { repositoryFromRemote } from "./pull-requests.ts";

export type PreflightDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly runtimePath: string;
}>;

export type DeliveryPreflightResult = Readonly<{
  readonly taskId: string;
  readonly ready: boolean;
  readonly reviewedHead?: string;
  readonly currentHead?: string;
  readonly branch?: string;
  /** The GitHub owner/repository read from the worktree's origin. */
  readonly repository?: string;
  readonly base: string;
  /** One plain-English line per reason publishing would be wrong or impossible. */
  readonly refusals: readonly string[];
  readonly duplicatePullRequest?: TaskRecord["pullRequest"];
  /** The task's own draft, which final publication updates in place rather than duplicating. */
  readonly draftPullRequest?: TaskRecord["pullRequest"];
}>;

function githubRepository(remote: string): string | undefined {
  try {
    return repositoryFromRemote(remote);
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Read-only checks that a ready task can be published. It refuses only what makes publishing wrong
 * or impossible: a dirty worktree, a HEAD or branch other than the reviewed one, no GitHub origin,
 * or an open pull request already on the branch. Quality checks are not rerun here; validation
 * already ran the repository's own configured commands at the reviewed HEAD.
 */
export async function deliveryPreflight(
  deps: PreflightDependencies,
  task: TaskRecord,
  base: string,
): Promise<DeliveryPreflightResult> {
  const taskId = task.id;
  const runtime = taskRuntime(await readRuntimeState(deps.runtimePath), taskId);
  const cwd = task.worktree?.path ?? runtime?.worktree?.path;
  const refusals: string[] = [];
  if (task.stage !== "ready") refusals.push(`the task is ${task.stage}, not ready to publish`);
  const worktree = task.worktree;
  if (cwd === undefined || task.reviewHead === undefined || worktree === undefined) {
    refusals.push("the task has no worktree or reviewed HEAD to publish");
    return {
      taskId,
      ready: false,
      ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
      base,
      refusals,
    };
  }
  const current = await readCheckpoint(deps.run, { repo: cwd, baseRef: worktree.baseHead }).catch(
    (): Partial<GitCheckpoint> => ({}),
  );
  if (current.dirty !== false || current.unmerged !== false) {
    refusals.push("the worktree has uncommitted or unmerged changes");
  }
  if (current.head !== task.reviewHead) {
    refusals.push(
      `the worktree is at ${current.head ?? "an unknown commit"}, not the reviewed commit ${task.reviewHead}`,
    );
  }
  const branch = await readGitText(
    deps.run,
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "delivery worktree branch",
  ).catch(() => undefined);
  if (branch !== worktree.branch) {
    refusals.push(`the worktree is on ${branch ?? "no branch"}, not ${worktree.branch}`);
  }
  const remote = await readGitText(
    deps.run,
    cwd,
    ["remote", "get-url", "origin"],
    "delivery remote identity",
  ).catch(() => undefined);
  const repository = remote === undefined ? undefined : githubRepository(remote);
  if (repository === undefined) {
    refusals.push(
      remote === undefined
        ? "the worktree has no origin remote"
        : `origin ${remote} is not a GitHub repository`,
    );
    return {
      taskId,
      ready: false,
      reviewedHead: task.reviewHead,
      ...(current.head === undefined ? {} : { currentHead: current.head }),
      ...(branch === undefined ? {} : { branch }),
      base,
      refusals,
    };
  }
  let duplicatePullRequest: TaskRecord["pullRequest"];
  let draftPullRequest: TaskRecord["pullRequest"];
  const ownDraft =
    task.pullRequest !== undefined &&
    task.pullRequest.state === "draft" &&
    task.pullRequest.repository === repository &&
    task.pullRequest.base === base;
  if (task.pullRequest !== undefined && !ownDraft) {
    refusals.push(`the task already has pull request #${task.pullRequest.number}`);
    duplicatePullRequest = task.pullRequest;
  } else {
    if (task.pullRequest !== undefined) draftPullRequest = task.pullRequest;
    try {
      const lookup = await deps.run({
        argv: [
          "gh",
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          worktree.branch,
          "--state",
          "open",
          "--json",
          "number,headRefOid,baseRefName,url,title,isDraft",
        ],
        cwd,
      });
      if (lookup.code !== 0) {
        refusals.push(
          `could not reach ${repository} on GitHub: ${firstLine(lookup.stderr || lookup.stdout)}`,
        );
      } else {
        const payload: unknown = JSON.parse(lookup.stdout || "[]");
        if (Array.isArray(payload) && payload.length > 0 && isRecord(payload[0])) {
          const entry = payload[0];
          if (
            Number.isSafeInteger(entry.number) &&
            typeof entry.headRefOid === "string" &&
            typeof entry.baseRefName === "string"
          ) {
            const observed: NonNullable<TaskRecord["pullRequest"]> = {
              repository,
              number: entry.number as number,
              state: entry.isDraft === true ? "draft" : "open",
              head: entry.headRefOid,
              base: entry.baseRefName,
              ...(typeof entry.url === "string" ? { url: entry.url } : {}),
              ...(typeof entry.title === "string" ? { title: entry.title } : {}),
            };
            if (draftPullRequest?.number === observed.number) {
              draftPullRequest = observed;
            } else {
              duplicatePullRequest = observed;
              refusals.push(`pull request #${entry.number} is already open for ${worktree.branch}`);
            }
          } else {
            refusals.push("GitHub returned an unreadable pull request for this branch");
          }
        }
      }
    } catch (error) {
      refusals.push(`could not reach ${repository} on GitHub: ${firstLine(describeError(error))}`);
    }
  }
  return {
    taskId,
    ready: refusals.length === 0,
    reviewedHead: task.reviewHead,
    ...(current.head === undefined ? {} : { currentHead: current.head }),
    ...(branch === undefined ? {} : { branch }),
    repository,
    base,
    refusals,
    ...(duplicatePullRequest === undefined ? {} : { duplicatePullRequest }),
    ...(draftPullRequest === undefined ? {} : { draftPullRequest }),
  };
}
