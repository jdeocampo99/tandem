import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState } from "../runtime/persistence.ts";
import { describeError, isRecord } from "../service/records.ts";

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
  readonly repository: string;
  readonly base: string;
  readonly checks: readonly Readonly<{
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }>[];
  readonly refusals: readonly string[];
  readonly duplicatePullRequest?: TaskRecord["pullRequest"];
  /** The task's own draft, which final publication updates in place rather than duplicating. */
  readonly draftPullRequest?: TaskRecord["pullRequest"];
}>;

async function gitText(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await run({ argv: ["git", "-C", cwd, ...args], cwd });
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function repositoryFromRemote(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/u, "");
  if (value.startsWith("git@github.com:")) return value.slice("git@github.com:".length);
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    return parsed.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
  } catch {
    return /^[^\s/]+\/[^\s/]+$/u.test(value) ? value : undefined;
  }
}

/**
 * Read-only checks that a ready task can be published: a clean worktree at the reviewed HEAD on
 * its own branch, the expected remote, passing quality checks, and no duplicate pull request.
 */
export async function deliveryPreflight(
  deps: PreflightDependencies,
  task: TaskRecord,
  repository: string,
  base: string,
): Promise<DeliveryPreflightResult> {
  const taskId = task.id;
  const runtime = taskRuntime(await readRuntimeState(deps.runtimePath), taskId);
  const cwd = task.worktree?.path ?? runtime?.worktree?.path;
  const checks: Array<{
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }> = [];
  const refusals: string[] = [];
  if (task.stage !== "ready") refusals.push(`task stage ${task.stage} is not ready for delivery`);
  const worktree = task.worktree;
  if (cwd === undefined || task.reviewHead === undefined || worktree === undefined) {
    refusals.push("delivery requires a durable worktree and reviewed HEAD");
    return {
      taskId,
      ready: false,
      ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
      repository,
      base,
      checks,
      refusals,
    };
  }
  const current = await readCheckpoint(deps.run, { repo: cwd, baseRef: worktree.baseHead }).catch(
    (): Partial<GitCheckpoint> => ({}),
  );
  const clean = current.dirty === false && current.unmerged === false;
  checks.push({
    name: "clean-worktree",
    passed: clean,
    detail: clean ? "clean" : "worktree is dirty or unmerged",
  });
  checks.push({
    name: "reviewed-head",
    passed: current.head === task.reviewHead,
    detail: `reviewed=${task.reviewHead}; current=${String(current.head)}`,
  });
  const branch = await gitText(deps.run, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  checks.push({
    name: "branch",
    passed: branch === worktree.branch,
    detail: `expected=${worktree.branch}; current=${String(branch)}`,
  });
  const remote = await gitText(deps.run, cwd, ["remote", "get-url", "origin"]);
  const remoteMatches = remote !== undefined && repositoryFromRemote(remote) === repository;
  checks.push({
    name: "remote",
    passed: remoteMatches,
    detail: remote === undefined ? "origin unavailable" : remote,
  });
  const qualityChecks = [
    { name: "generated-database-types", argv: ["bun", "run", "db:types:check"] as const },
    { name: "format", argv: ["bunx", "biome", "format", "--check", "."] as const },
    { name: "pre-push", argv: ["bun", "run", "lint"] as const },
    { name: "git-diff-check", argv: ["git", "-C", cwd, "diff", "--check"] as const },
  ] as const;
  for (const check of qualityChecks) {
    try {
      const result = await deps.run({ argv: check.argv, cwd });
      checks.push({
        name: check.name,
        passed: result.code === 0,
        detail: result.code === 0 ? "passed" : result.stderr || result.stdout,
      });
    } catch (error) {
      checks.push({ name: check.name, passed: false, detail: describeError(error) });
    }
  }
  let duplicatePullRequest: TaskRecord["pullRequest"];
  let draftPullRequest: TaskRecord["pullRequest"];
  const ownDraft =
    task.pullRequest !== undefined &&
    task.pullRequest.state === "draft" &&
    task.pullRequest.repository === repository &&
    task.pullRequest.base === base;
  if (task.pullRequest !== undefined && !ownDraft) {
    refusals.push(
      `task already has pull request #${task.pullRequest.number}; duplicate publication is refused`,
    );
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
        refusals.push(`duplicate pull-request lookup failed: ${lookup.stderr || lookup.stdout}`);
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
              refusals.push(
                `open pull request #${entry.number} already exists for ${worktree.branch}`,
              );
            }
          } else {
            refusals.push("duplicate pull-request lookup returned malformed metadata");
          }
        }
      }
    } catch (error) {
      refusals.push(`duplicate pull-request lookup unavailable: ${describeError(error)}`);
    }
  }
  for (const check of checks) {
    if (!check.passed) refusals.push(`${check.name}: ${check.detail}`);
  }
  return {
    taskId,
    ready: refusals.length === 0,
    reviewedHead: task.reviewHead,
    ...(current.head === undefined ? {} : { currentHead: current.head }),
    ...(branch === undefined ? {} : { branch }),
    repository,
    base,
    checks,
    refusals,
    ...(duplicatePullRequest === undefined ? {} : { duplicatePullRequest }),
    ...(draftPullRequest === undefined ? {} : { draftPullRequest }),
  };
}
