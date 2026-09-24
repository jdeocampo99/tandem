import { isRecord } from "../adapters/primitives.ts";
import type { CommandRunner } from "../contracts.ts";

/** A pull request named by the user, before anything is read from GitHub. */
export type PullRequestRef = Readonly<{ repo: string; number: number }>;

export type CiSummary = Readonly<{
  failing: readonly string[];
  pending: readonly string[];
  passing: number;
}>;

/** What a review needs to know about the pull request, read once from `gh pr view`. */
export type PullRequestFacts = Readonly<{
  ref: PullRequestRef;
  url: string;
  title: string;
  body: string;
  author: string;
  headOid: string;
  baseRef: string;
  isDraft: boolean;
  conflicting: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  linkedIssues: readonly Readonly<{ number: number; title: string }>[];
  ci: CiSummary;
}>;

/** Why a review cannot start, phrased for the user in one line. */
export type PullRequestRefusal = Readonly<{ kind: "refused"; message: string }>;

const PR_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i;
const PR_SHORTHAND = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

const VIEW_FIELDS = [
  "number",
  "url",
  "title",
  "body",
  "author",
  "state",
  "isDraft",
  "mergeable",
  "headRefOid",
  "baseRefName",
  "additions",
  "deletions",
  "changedFiles",
  "closingIssuesReferences",
  "statusCheckRollup",
].join(",");

/** Accepts a GitHub PR URL or `owner/repo#123`. */
export function parsePullRequestRef(text: string): PullRequestRef | undefined {
  const trimmed = text.trim();
  const match = PR_URL.exec(trimmed) ?? PR_SHORTHAND.exec(trimmed);
  if (match === null) return undefined;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return undefined;
  return { repo: `${owner}/${repo}`.toLowerCase(), number: Number(number) };
}

/** The first PR link in free text, so "can you look at <url>?" still finds it. */
export function findPullRequestRef(text: string): PullRequestRef | undefined {
  for (const word of text.split(/\s+/)) {
    const ref = parsePullRequestRef(word.replace(/^[<(]+|[>).,!?]+$/g, ""));
    if (ref !== undefined) return ref;
  }
  return undefined;
}

/**
 * Reads the pull request and refuses the ones not worth reviewing. Drafts and conflicts still get
 * reviewed; they are noted in the acknowledgement instead.
 */
export async function readPullRequest(
  run: CommandRunner,
  ref: PullRequestRef,
  cwd: string,
): Promise<PullRequestFacts | PullRequestRefusal> {
  const result = await run({
    argv: ["gh", "pr", "view", String(ref.number), "--repo", ref.repo, "--json", VIEW_FIELDS],
    cwd,
  });
  if (result.code !== 0) {
    return {
      kind: "refused",
      message: `I can't open ${ref.repo}#${ref.number} with your GitHub login: ${firstLine(result.stderr)}`,
    };
  }
  const view: unknown = JSON.parse(result.stdout);
  if (!isRecord(view)) throw new TypeError("gh pr view returned a non-object");
  const state = text(view.state);
  if (state === "MERGED") {
    return { kind: "refused", message: `${ref.repo}#${ref.number} is already merged.` };
  }
  if (state === "CLOSED") {
    return { kind: "refused", message: `${ref.repo}#${ref.number} is closed.` };
  }
  return {
    ref,
    url: text(view.url),
    title: text(view.title),
    body: text(view.body),
    author: isRecord(view.author) ? text(view.author.login) : "",
    headOid: text(view.headRefOid),
    baseRef: text(view.baseRefName),
    isDraft: view.isDraft === true,
    conflicting: view.mergeable === "CONFLICTING",
    additions: count(view.additions),
    deletions: count(view.deletions),
    changedFiles: count(view.changedFiles),
    linkedIssues: list(view.closingIssuesReferences).flatMap((issue) =>
      isRecord(issue) ? [{ number: count(issue.number), title: text(issue.title) }] : [],
    ),
    ci: summarizeChecks(list(view.statusCheckRollup)),
  };
}

export function isRefusal(
  value: PullRequestFacts | PullRequestRefusal,
): value is PullRequestRefusal {
  return "kind" in value;
}

/** Check runs and legacy status contexts, reduced to what a reviewer acts on. */
export function summarizeChecks(checks: readonly unknown[]): CiSummary {
  const failing: string[] = [];
  const pending: string[] = [];
  let passing = 0;
  for (const check of checks) {
    if (!isRecord(check)) continue;
    const name = text(check.name) || text(check.context);
    const outcome = (text(check.conclusion) || text(check.state)).toUpperCase();
    const running = text(check.status).toUpperCase();
    if (running !== "" && running !== "COMPLETED") pending.push(name);
    else if (outcome === "SUCCESS" || outcome === "NEUTRAL" || outcome === "SKIPPED") passing += 1;
    else if (outcome === "PENDING" || outcome === "EXPECTED") pending.push(name);
    else failing.push(name);
  }
  return { failing, pending, passing };
}

/**
 * The one-line acknowledgement: lens, size, reading time, CI, and anything unusual.
 * ponytail: reading time assumes ~40 changed lines a minute; tune once real reviews are timed.
 */
export function acknowledgement(facts: PullRequestFacts, lensLabel: string): string {
  const changed = facts.additions + facts.deletions;
  const size = changed < 100 ? "Small" : changed < 600 ? "Medium" : "Large";
  const minutes = Math.max(1, Math.round(changed / 40));
  const parts = [
    `Reviewing ${facts.ref.repo}#${facts.ref.number}${lensLabel === "" ? "" : ` ${lensLabel}`}.`,
    `${size} PR, about a ${minutes}-minute read.`,
    ciLine(facts.ci),
  ];
  if (facts.isDraft) parts.push("It's still a draft.");
  if (facts.conflicting) parts.push("It has merge conflicts with its base.");
  return parts.join(" ");
}

function ciLine(ci: CiSummary): string {
  if (ci.failing.length > 0) return `CI failing on ${ci.failing.join(", ")}.`;
  if (ci.pending.length > 0) return "CI still running.";
  if (ci.passing > 0) return "CI green.";
  return "No CI checks.";
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
