import { isRecord } from "../adapters/primitives.ts";
import type { CommandResult, CommandRunner } from "../contracts.ts";
import { checkOutcome, parseRemoteCheck, repositoryFromRemote } from "../delivery/pull-requests.ts";
import type { PullRequestRef } from "../pr-review/pull-request.ts";
import type { Dequeuer, MergingSettings, PrObservation, WatchedCheck } from "./decide.ts";

/** GitHub refused because of its rate limit; the watcher backs off instead of reading on. */
export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/**
 * Which of a head's reported checks branch protection requires. Kept per head and read again only
 * when a check GitHub had not reported before shows up.
 */
export type RequiredChecks = Readonly<{
  readonly head: string;
  readonly checks: readonly string[];
  readonly required: readonly string[];
}>;

/** A user's open pull request as GitHub's search reports it. */
export type AuthoredPullRequest = Readonly<{
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
}>;

export type PullRequestRead =
  | Readonly<{
      readonly kind: "read";
      readonly observation: PrObservation;
      readonly required: RequiredChecks;
    }>
  /** Why GitHub would not show it, such as a missing SSO authorization. Never "no checks". */
  | Readonly<{ readonly kind: "unreadable"; readonly reason: string }>;

export type EmptyCommitResult =
  | Readonly<{ readonly kind: "pushed"; readonly commit: string }>
  /** Someone pushed after the watcher looked; the branch was left as they pushed it. */
  | Readonly<{ readonly kind: "moved" }>;

const VIEW_FIELDS = [
  "state",
  "isDraft",
  "title",
  "url",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "isCrossRepository",
  "baseRefName",
  "baseRefOid",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "reviewRequests",
  "labels",
  "autoMergeRequest",
  "mergedAt",
  "statusCheckRollup",
].join(",");
/** `gh pr view` returns at most this many checks; a full page means there may be more. */
const CHECKS_PAGE = 100;
const RATE_LIMITED = /rate limit|HTTP 429/iu;
const NOT_FAST_FORWARD = /fast.forward|HTTP 422/iu;
const BASE_CHECKS_QUERY = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          statusCheckRollup {
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun { name status conclusion }
                ... on StatusContext { context state }
              }
            }
          }
        }
      }
    }
  }
}`;
const REQUIRED_CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $endCursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun { name isRequired(pullRequestNumber: $number) }
                  ... on StatusContext { context isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

type UnflaggedCheck = Omit<WatchedCheck, "required">;

/**
 * Reads one pull request for the watcher: one `gh pr view`, every page of checks when there are
 * more than fit in it, the head commit's tree when the head is new, and which checks are required
 * when a check shows up that was not known yet.
 */
export async function readWatchedPullRequest(
  run: CommandRunner,
  ref: PullRequestRef,
  input: Readonly<{
    cwd: string;
    knownTree?: Readonly<{ head: string; tree: string }>;
    knownRequired?: RequiredChecks;
  }>,
): Promise<PullRequestRead> {
  const viewed = await gh(run, input.cwd, [
    "pr",
    "view",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    VIEW_FIELDS,
  ]);
  if (viewed.code !== 0) return { kind: "unreadable", reason: firstLine(viewed.stderr) };
  const view = parseObject(viewed.stdout);
  if (view === undefined || !Array.isArray(view.statusCheckRollup)) {
    return { kind: "unreadable", reason: "GitHub returned an incomplete pull request" };
  }
  const head = text(view.headRefOid);
  const rollup: readonly unknown[] = view.statusCheckRollup;
  const checks =
    rollup.length >= CHECKS_PAGE
      ? await readAllChecks(run, ref, input.cwd)
      : watchedChecks(rollup, viewed.stdout);
  const tree =
    input.knownTree?.head === head
      ? input.knownTree.tree
      : await readTree(run, ref.repo, head, input.cwd);
  const names = checks.map((check) => check.name);
  const known = input.knownRequired;
  const required: RequiredChecks =
    known?.head === head && names.every((name) => known.checks.includes(name))
      ? known
      : {
          head,
          checks: names,
          required: names.length === 0 ? [] : await readRequiredChecks(run, ref, input.cwd),
        };
  const flagged = checks.map((check) => ({
    ...check,
    required: required.required.includes(check.name),
  }));
  return {
    kind: "read",
    observation: observation(view, ref, { head, tree, checks: flagged }),
    required,
  };
}

/**
 * The names of the checks branch protection requires on this pull request. `gh pr view` does
 * not say, so this asks GraphQL, every page.
 */
async function readRequiredChecks(
  run: CommandRunner,
  ref: PullRequestRef,
  cwd: string,
): Promise<readonly string[]> {
  const [owner, name] = ref.repo.split("/");
  const result = await ghChecked(run, cwd, [
    "api",
    "graphql",
    "--paginate",
    "-f",
    `query=${REQUIRED_CHECKS_QUERY}`,
    "-f",
    `owner=${owner ?? ""}`,
    "-f",
    `name=${name ?? ""}`,
    "-F",
    `number=${ref.number}`,
    "--jq",
    ".data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.isRequired) | (.name // .context)",
  ]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The names of the checks not passing on the tip of a branch, such as the pull request's base:
 * failed, or still running and so not yet known to pass.
 */
export async function readChecksNotPassing(
  run: CommandRunner,
  repository: string,
  branch: string,
  cwd: string,
): Promise<ReadonlySet<string>> {
  const [owner, name] = repository.split("/");
  const result = await ghChecked(run, cwd, [
    "api",
    "graphql",
    "-f",
    `query=${BASE_CHECKS_QUERY}`,
    "-f",
    `owner=${owner ?? ""}`,
    "-f",
    `name=${name ?? ""}`,
    "-f",
    `ref=refs/heads/${branch}`,
  ]);
  const nodes = pathOf(parseObject(result.stdout), [
    "data",
    "repository",
    "ref",
    "target",
    "statusCheckRollup",
    "contexts",
    "nodes",
  ]);
  const checks = Array.isArray(nodes) ? watchedChecks(nodes, result.stdout) : [];
  return new Set(checks.filter((check) => check.state !== "passed").map((check) => check.name));
}

/**
 * Reruns CI without a checkout: creates a commit with the head's tree and the head as its parent,
 * then moves the branch to it without force. If someone pushed in between, GitHub refuses the move
 * and the branch keeps their push.
 */
export async function pushEmptyCommit(
  run: CommandRunner,
  input: Readonly<{
    repository: string;
    branch: string;
    head: string;
    tree: string;
    message: string;
    cwd: string;
  }>,
): Promise<EmptyCommitResult> {
  const created = await ghChecked(run, input.cwd, [
    "api",
    "-X",
    "POST",
    `repos/${input.repository}/git/commits`,
    "-f",
    `message=${input.message}`,
    "-f",
    `tree=${input.tree}`,
    "-f",
    `parents[]=${input.head}`,
    "--jq",
    ".sha",
  ]);
  const commit = created.stdout.trim();
  const moved = await gh(run, input.cwd, [
    "api",
    "-X",
    "PATCH",
    `repos/${input.repository}/git/refs/heads/${input.branch}`,
    "-f",
    `sha=${commit}`,
    "-F",
    "force=false",
  ]);
  if (moved.code === 0) return { kind: "pushed", commit };
  if (NOT_FAST_FORWARD.test(moved.stderr)) return { kind: "moved" };
  throw new Error(`GitHub did not move ${input.branch}: ${firstLine(moved.stderr)}`);
}

/** What the repository settings say, or why `gh` can't read them. */
export type RepositoryRead =
  | Readonly<{
      readonly readable: true;
      readonly defaultBranch: string;
      /** GitHub's "Allow auto-merge"; undefined when this login can't see it. */
      readonly allowAutoMerge?: boolean;
    }>
  | Readonly<{ readonly readable: false; readonly reason: string }>;

/** What branch rules and classic protection say about merging into one branch. */
export type BranchRules = Readonly<{
  readonly requiredChecks: "yes" | "none" | "unknown";
  readonly dismissesApprovals: "yes" | "no" | "unknown";
}>;

export async function readRepository(
  run: CommandRunner,
  repository: string,
  cwd: string,
): Promise<RepositoryRead> {
  const result = await gh(run, cwd, [
    "api",
    `repos/${repository}`,
    "--jq",
    "{allow_auto_merge, default_branch}",
  ]);
  if (result.code !== 0) return { readable: false, reason: firstLine(result.stderr) };
  const repo = parseObject(result.stdout);
  if (repo === undefined || text(repo.default_branch).length === 0) {
    return { readable: false, reason: "GitHub returned no repository settings" };
  }
  return {
    readable: true,
    defaultBranch: text(repo.default_branch),
    ...(typeof repo.allow_auto_merge === "boolean"
      ? { allowAutoMerge: repo.allow_auto_merge }
      : {}),
  };
}

/**
 * Whether merging into a branch needs checks and whether a push dismisses approvals, from its
 * rulesets and, when this login may read it, its classic protection. Unknown when neither says.
 */
export async function readBranchRules(
  run: CommandRunner,
  repository: string,
  branch: string,
  cwd: string,
): Promise<BranchRules> {
  const rules = await gh(run, cwd, ["api", `repos/${repository}/rules/branches/${branch}`]);
  const ruleList: unknown = rules.code === 0 ? parseJsonValue(rules.stdout) : undefined;
  const typed = Array.isArray(ruleList) ? ruleList.filter(isRecord) : [];
  const checksRule = typed.find((rule) => rule.type === "required_status_checks");
  const reviewRule = typed.find((rule) => rule.type === "pull_request");
  const protection = await gh(run, cwd, [
    "api",
    `repos/${repository}/branches/${branch}/protection`,
  ]);
  const unprotected = protection.code !== 0 && /not protected|HTTP 404/iu.test(protection.stderr);
  const classic = protection.code === 0 ? parseObject(protection.stdout) : undefined;
  const classicChecks = isRecord(classic?.required_status_checks)
    ? list(classic.required_status_checks.contexts).length +
      list(classic.required_status_checks.checks).length
    : 0;
  const classicReviews = isRecord(classic?.required_pull_request_reviews)
    ? classic.required_pull_request_reviews
    : undefined;
  const reviewParameters = isRecord(reviewRule?.parameters) ? reviewRule.parameters : undefined;
  const known = Array.isArray(ruleList) && (classic !== undefined || unprotected);
  return {
    requiredChecks:
      checksRule !== undefined || classicChecks > 0 ? "yes" : known ? "none" : "unknown",
    dismissesApprovals:
      reviewParameters?.dismiss_stale_reviews_on_push === true ||
      classicReviews?.dismiss_stale_reviews === true
        ? "yes"
        : known
          ? "no"
          : "unknown",
  };
}

/** Whether the repository's default branch has an Aviator merge queue config. */
export async function hasAviatorConfig(
  run: CommandRunner,
  repository: string,
  cwd: string,
): Promise<boolean> {
  const result = await gh(run, cwd, [
    "api",
    `repos/${repository}/contents/.aviator/config.yml`,
    "--jq",
    ".path",
  ]);
  if (result.code === 0) return true;
  if (/HTTP 404/u.test(result.stderr)) return false;
  throw new Error(`gh could not look for an Aviator config: ${firstLine(result.stderr)}`);
}

/**
 * Who last took the pull request out of the queue: added the blocked label or removed the queue
 * label, or turned auto-merge off. A bot or GitHub app counts as the queue itself.
 */
export async function readDequeuer(
  run: CommandRunner,
  ref: PullRequestRef,
  settings: MergingSettings,
  cwd: string,
): Promise<Dequeuer> {
  const result = await ghChecked(run, cwd, [
    "api",
    `repos/${ref.repo}/issues/${ref.number}/events?per_page=100`,
    "--paginate",
    "--jq",
    ".[] | {event, label: .label.name, login: .actor.login, type: .actor.type}",
  ]);
  const dequeues = result.stdout
    .split("\n")
    .flatMap((line) => (line.trim().length === 0 ? [] : [parseObject(line)]))
    .filter((event): event is Readonly<Record<string, unknown>> => {
      if (event === undefined) return false;
      if (settings.mergeWith === "auto-merge") return event.event === "auto_merge_disabled";
      return (
        (event.event === "labeled" && event.label === settings.blockedLabel) ||
        (event.event === "unlabeled" && event.label === settings.queueLabel)
      );
    });
  const last = dequeues.at(-1);
  if (last === undefined) return null;
  const login = text(last.login);
  return { login, bot: last.type === "Bot" || login.endsWith("[bot]") };
}

/** Adds and removes labels in one edit, such as swapping the blocked label for the queue label. */
export async function editLabels(
  run: CommandRunner,
  ref: PullRequestRef,
  labels: Readonly<{ add: string; remove?: string }>,
  cwd: string,
): Promise<void> {
  await ghChecked(run, cwd, [
    "pr",
    "edit",
    String(ref.number),
    "--repo",
    ref.repo,
    "--add-label",
    labels.add,
    ...(labels.remove === undefined ? [] : ["--remove-label", labels.remove]),
  ]);
}

/**
 * Turns on GitHub auto-merge for this exact head, with the first merge method the repository
 * allows of squash, merge commit, and rebase.
 */
export async function enableAutoMerge(
  run: CommandRunner,
  ref: PullRequestRef,
  head: string,
  cwd: string,
): Promise<void> {
  const allowed = await ghChecked(run, cwd, [
    "repo",
    "view",
    ref.repo,
    "--json",
    "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
  ]);
  const methods = parseObject(allowed.stdout) ?? {};
  const method =
    methods.squashMergeAllowed === true
      ? "--squash"
      : methods.mergeCommitAllowed === true
        ? "--merge"
        : "--rebase";
  await ghChecked(run, cwd, [
    "pr",
    "merge",
    String(ref.number),
    "--repo",
    ref.repo,
    "--auto",
    method,
    "--match-head-commit",
    head,
  ]);
}

/**
 * Brings a branch up to date by merging its base into it through the GitHub API, which only ever
 * adds a commit on top. Returns the merge commit, or undefined when there was nothing to merge.
 */
export async function mergeBaseIntoBranch(
  run: CommandRunner,
  input: Readonly<{ repository: string; branch: string; base: string; cwd: string }>,
): Promise<string | undefined> {
  const result = await ghChecked(run, input.cwd, [
    "api",
    "-X",
    "POST",
    `repos/${input.repository}/merges`,
    "-f",
    `base=${input.branch}`,
    "-f",
    `head=${input.base}`,
    "-f",
    `commit_message=Merge ${input.base} into ${input.branch}`,
    "--jq",
    ".sha",
  ]);
  const sha = result.stdout.trim();
  return sha.length === 0 ? undefined : sha;
}

/**
 * The files a pull request and its base both changed since they split: where its conflicts are.
 * GitHub does not name conflicting files, so this is the closest it can tell without a checkout.
 */
export async function readConflictFiles(
  run: CommandRunner,
  repository: string,
  range: Readonly<{ base: string; head: string }>,
  cwd: string,
): Promise<readonly string[]> {
  const changed = async (from: string, to: string): Promise<readonly string[]> => {
    const result = await ghChecked(run, cwd, [
      "api",
      `repos/${repository}/compare/${from}...${to}`,
      "--jq",
      "[.files[].filename]",
    ]);
    const files: unknown = JSON.parse(result.stdout);
    return Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
  };
  const ours = await changed(range.base, range.head);
  const theirs = new Set(await changed(range.head, range.base));
  return ours.filter((file) => theirs.has(file));
}

/** Every open pull request the signed-in GitHub user authored, across repositories. */
export async function listMyOpenPullRequests(
  run: CommandRunner,
  cwd: string,
): Promise<readonly AuthoredPullRequest[]> {
  const result = await ghChecked(run, cwd, [
    "search",
    "prs",
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "number,repository,title,url,isDraft",
    "--limit",
    "100",
  ]);
  const found: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(found)) throw new Error("gh search prs did not return a list");
  return found.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.number !== "number" || !isRecord(entry.repository)) {
      return [];
    }
    const repo = text(entry.repository.nameWithOwner).toLowerCase();
    if (repo.length === 0) return [];
    return [
      {
        ref: { repo, number: entry.number },
        title: text(entry.title),
        url: text(entry.url),
        draft: entry.isDraft === true,
      },
    ];
  });
}

async function readAllChecks(
  run: CommandRunner,
  ref: PullRequestRef,
  cwd: string,
): Promise<readonly UnflaggedCheck[]> {
  const result = await ghChecked(run, cwd, [
    "pr",
    "checks",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    "name,state,bucket,link,startedAt",
  ]);
  const checks: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(checks)) throw new Error("gh pr checks did not return a list");
  return watchedChecks(checks, result.stdout);
}

async function readTree(
  run: CommandRunner,
  repository: string,
  head: string,
  cwd: string,
): Promise<string> {
  const result = await ghChecked(run, cwd, [
    "api",
    `repos/${repository}/commits/${head}`,
    "--jq",
    ".commit.tree.sha",
  ]);
  return result.stdout.trim();
}

function watchedChecks(values: readonly unknown[], response: string): readonly UnflaggedCheck[] {
  return values.map((value, index) => {
    const check = parseRemoteCheck(value, index, response);
    return {
      name: check.name,
      state: checkOutcome(check),
      ...(check.url === undefined ? {} : { url: check.url }),
      ...(check.startedAt === undefined ? {} : { startedAt: check.startedAt }),
    };
  });
}

function observation(
  view: Readonly<Record<string, unknown>>,
  ref: PullRequestRef,
  read: Readonly<{ head: string; tree: string; checks: readonly WatchedCheck[] }>,
): PrObservation {
  const state = text(view.state).toLowerCase();
  const mergeable = text(view.mergeable);
  const reviewDecision = text(view.reviewDecision);
  const headOwner = isRecord(view.headRepositoryOwner) ? text(view.headRepositoryOwner.login) : "";
  const headName = isRecord(view.headRepository) ? text(view.headRepository.name) : "";
  const mergedAt = text(view.mergedAt);
  return {
    state: state === "merged" || state === "closed" ? state : "open",
    draft: view.isDraft === true,
    title: text(view.title),
    url: text(view.url),
    branch: text(view.headRefName),
    headRepository:
      headOwner.length > 0 && headName.length > 0 ? `${headOwner}/${headName}` : ref.repo,
    fork: view.isCrossRepository === true,
    head: read.head,
    tree: read.tree,
    base: text(view.baseRefName),
    baseHead: text(view.baseRefOid),
    mergeable: mergeable === "MERGEABLE" || mergeable === "CONFLICTING" ? mergeable : "UNKNOWN",
    behind: view.mergeStateStatus === "BEHIND",
    reviewDecision:
      reviewDecision === "APPROVED" ||
      reviewDecision === "CHANGES_REQUESTED" ||
      reviewDecision === "REVIEW_REQUIRED"
        ? reviewDecision
        : "NONE",
    reviewers: list(view.reviewRequests).flatMap((request) =>
      isRecord(request) ? [text(request.login) || text(request.name)].filter(Boolean) : [],
    ),
    labels: list(view.labels).flatMap((label) => (isRecord(label) ? [text(label.name)] : [])),
    autoMerge: isRecord(view.autoMergeRequest),
    ...(mergedAt.length === 0 ? {} : { mergedAt }),
    checks: read.checks,
  };
}

async function gh(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await run({ argv: ["gh", ...args], cwd });
  if (result.code !== 0 && RATE_LIMITED.test(result.stderr)) {
    throw new GitHubRateLimitError(firstLine(result.stderr));
  }
  return result;
}

async function ghChecked(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await gh(run, cwd, args);
  if (result.code !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${firstLine(result.stderr)}`);
  }
  return result;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseObject(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pathOf(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return current;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] || "gh failed without a message";
}

/** The GitHub `owner/repo` a checkout's origin names, or undefined when it names none. */
export async function originRepository(
  run: CommandRunner,
  repoPath: string,
): Promise<string | undefined> {
  const result = await run({
    argv: ["git", "-C", repoPath, "remote", "get-url", "origin"],
    cwd: repoPath,
  });
  if (result.code !== 0) return undefined;
  try {
    return repositoryFromRemote(result.stdout).toLowerCase();
  } catch {
    return undefined;
  }
}
