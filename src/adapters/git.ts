import type { CommandRequest, CommandRunner, PullRequestMetadata } from "../contracts.ts";
import {
  AdapterProtocolError,
  ApprovalRequiredError,
  checkedPath,
  checkedText,
  optionalString,
  parseJson,
  readGitText,
  requiredInteger,
  requiredRecord,
  requiredString,
  runChecked,
} from "./primitives.ts";

const MERGE_METHODS: Readonly<Record<string, true>> = {
  merge: true,
  squash: true,
  rebase: true,
};

export type GitCheckpointInput = Readonly<{
  repo: string;
  baseRef?: string;
}>;

export type GitCheckpoint = Readonly<{
  head: string;
  base: string;
  diff: string;
  dirty: boolean;
  unmerged: boolean;
}>;

export type PublishPullRequestInput = Readonly<{
  cwd: string;
  repository: string;
  title: string;
  body: string;
  base: string;
  head: string;
}>;

export type MergePullRequestInput = Readonly<{
  cwd: string;
  repository: string;
  number: number;
  expectedHead: string;
  method: "merge" | "squash" | "rebase";
  approved: boolean;
}>;

export async function readCheckpoint(
  run: CommandRunner,
  input: GitCheckpointInput,
): Promise<GitCheckpoint> {
  const repo = checkedPath(input.repo, "repo");
  const baseRef = input.baseRef === undefined ? "HEAD" : checkedText(input.baseRef, "baseRef");
  const head = await readGitText(run, repo, ["rev-parse", "HEAD"], "git checkpoint HEAD");
  const base = await readGitText(run, repo, ["rev-parse", baseRef], "git checkpoint base");
  const diffRequest: CommandRequest = {
    argv: ["git", "-C", repo, "diff", "--no-ext-diff", "--binary", baseRef],
    cwd: repo,
  };
  const diff = (await runChecked(run, diffRequest, "git checkpoint diff")).stdout;
  const statusRequest: CommandRequest = {
    argv: ["git", "-C", repo, "status", "--porcelain=v1", "--untracked-files=all"],
    cwd: repo,
  };
  const status = (await runChecked(run, statusRequest, "git checkpoint status")).stdout;
  const unmergedRequest: CommandRequest = {
    argv: ["git", "-C", repo, "diff", "--name-only", "--diff-filter=U"],
    cwd: repo,
  };
  const unmerged = (await runChecked(run, unmergedRequest, "git checkpoint unmerged")).stdout;
  return {
    head,
    base,
    diff,
    dirty: status.trim().length !== 0,
    unmerged: unmerged.trim().length !== 0,
  };
}

function parsePullRequestMetadata(
  value: unknown,
  repository: string,
  operation: string,
  response: string,
): PullRequestMetadata {
  const root = requiredRecord(value, "response", operation, response);
  const number = requiredInteger(root.number, "number", operation, response);
  if (number < 1) throw new AdapterProtocolError(operation, "number must be positive", response);
  const rawState = requiredString(root.state, "state", operation, response).toLowerCase();
  if (rawState !== "open" && rawState !== "closed" && rawState !== "merged") {
    throw new AdapterProtocolError(
      operation,
      `unsupported pull request state ${JSON.stringify(rawState)}`,
      response,
    );
  }
  const head = requiredString(root.headRefOid, "headRefOid", operation, response);
  if (typeof root.isDraft !== "boolean") {
    throw new AdapterProtocolError(operation, "isDraft must be boolean", response);
  }
  const base = requiredString(root.baseRefName, "baseRefName", operation, response);
  const url = optionalString(root.url, "url", operation, response);
  const title = optionalString(root.title, "title", operation, response);
  return {
    repository,
    number,
    state: rawState === "open" && root.isDraft ? "draft" : rawState,
    head,
    base,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
  };
}

async function readPullRequest(
  run: CommandRunner,
  cwd: string,
  repository: string,
  selector: string,
  operation: string,
): Promise<PullRequestMetadata> {
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "view",
      selector,
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefName,title",
    ],
    cwd,
  };
  const result = await runChecked(run, request, operation);
  return parsePullRequestMetadata(
    parseJson(result.stdout, operation),
    repository,
    operation,
    result.stdout,
  );
}

function extractPullRequestSelector(output: string): string | undefined {
  return output
    .split(/\s+/u)
    .find((candidate) => candidate.startsWith("https://") || candidate.startsWith("http://"));
}

export async function publishPullRequest(
  run: CommandRunner,
  input: PublishPullRequestInput,
): Promise<PullRequestMetadata> {
  const cwd = checkedPath(input.cwd, "cwd");
  const repository = checkedText(input.repository, "repository");
  const title = checkedText(input.title, "title");
  const body = checkedText(input.body, "body");
  const base = checkedText(input.base, "base");
  const head = checkedText(input.head, "head");
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "create",
      "--repo",
      repository,
      "--title",
      title,
      "--body",
      body,
      "--base",
      base,
      "--head",
      head,
    ],
    cwd,
  };
  const result = await runChecked(run, request, "github pull request publish");
  const selector = extractPullRequestSelector(result.stdout);
  if (selector === undefined) {
    throw new AdapterProtocolError(
      "github pull request publish",
      "gh pr create omitted a pull request URL",
      result.stdout,
    );
  }
  return readPullRequest(run, cwd, repository, selector, "github pull request observe");
}

export async function mergePullRequest(
  run: CommandRunner,
  input: MergePullRequestInput,
): Promise<PullRequestMetadata> {
  const cwd = checkedPath(input.cwd, "cwd");
  const repository = checkedText(input.repository, "repository");
  const expectedHead = checkedText(input.expectedHead, "expectedHead");
  if (!Number.isSafeInteger(input.number) || input.number < 1) {
    throw new TypeError("pull request number must be a positive integer");
  }
  if (!input.approved) throw new ApprovalRequiredError("pull request merge");
  if (MERGE_METHODS[input.method] !== true)
    throw new TypeError("pull request merge method is unsupported");
  const selector = String(input.number);
  const observed = await readPullRequest(
    run,
    cwd,
    repository,
    selector,
    "github pull request merge precondition",
  );
  if (observed.head !== expectedHead) {
    throw new AdapterProtocolError(
      "github pull request merge",
      `observed pull request head ${JSON.stringify(observed.head)} does not match expected head ${JSON.stringify(expectedHead)}`,
      JSON.stringify(observed),
    );
  }
  const methodFlag = `--${input.method}`;
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "merge",
      selector,
      "--repo",
      repository,
      methodFlag,
      "--match-head-commit",
      expectedHead,
    ],
    cwd,
  };
  await runChecked(run, request, "github pull request merge");
  const merged = await readPullRequest(
    run,
    cwd,
    repository,
    selector,
    "github pull request merge observation",
  );
  if (merged.state !== "merged" || merged.head !== expectedHead) {
    throw new AdapterProtocolError(
      "github pull request merge observation",
      `pull request did not report merged state with expected head ${JSON.stringify(expectedHead)}`,
      JSON.stringify(merged),
    );
  }
  return merged;
}
