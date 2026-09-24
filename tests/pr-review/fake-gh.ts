import { runCommand } from "../../src/adapters/commands.ts";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/contracts.ts";

export type GhReply = CommandResult | ((request: CommandRequest) => CommandResult);

/**
 * A runner that answers `gh` from scripted replies, matched by the longest argv prefix, and runs
 * everything else (git) for real. Every call is recorded.
 */
export function fakeGh(replies: Record<string, GhReply>): {
  run: CommandRunner;
  calls: CommandRequest[];
} {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    if (request.argv[0] !== "gh") return runCommand(request);
    const line = request.argv.join(" ");
    const key = Object.keys(replies)
      .filter((prefix) => line.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return { code: 1, stdout: "", stderr: `no scripted reply for ${line}` };
    const reply = replies[key];
    if (reply === undefined) throw new Error("unreachable");
    return typeof reply === "function" ? reply(request) : reply;
  };
  return { run, calls };
}

export function ok(stdout: unknown): CommandResult {
  return {
    code: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
  };
}

export function failed(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr };
}

/** A `gh pr view --json` payload for an open PR, with overrides. */
export function prView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: "https://github.com/acme/api/pull/7",
    title: "Retry uploads",
    body: "Retries failed uploads twice.",
    author: { login: "sam" },
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: "abc123",
    baseRefName: "main",
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    closingIssuesReferences: [{ number: 3, title: "Uploads fail on flaky wifi" }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    ...overrides,
  };
}
