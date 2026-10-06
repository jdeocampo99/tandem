import type { RequestBriefRecord, TaskRecord } from "../contracts.ts";
import type { CoordinatorMessage } from "./coordinator-reply.ts";

export type NativeReplyLink = Readonly<{ label: string; url: string }>;
const safeId = /^[a-zA-Z0-9_-]+$/u;
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function mentioned(text: string, value: string): boolean {
  if (!value) return false;
  const escaped = escapePattern(value);
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "iu").test(text);
}

/** A numeric id in a count, an issue reference, or a title is not a domain reference. */
function explicitReference(text: string, kind: string, id: string): boolean {
  return new RegExp(
    `(?<![\\w-])${kind}(?:\\s+|\\s*[:#]\\s*)[\x60*]*#?${escapePattern(id)}(?![\\w-])`,
    "iu",
  ).test(text);
}

/** Resolve only mentioned durable identities in the coordinator's project. */
export function nativeReplyLinks(
  messages: readonly CoordinatorMessage[],
  tasks: readonly TaskRecord[],
  briefs: readonly RequestBriefRecord[],
  repoPath: string,
): readonly NativeReplyLink[] {
  const text = messages
    .filter((m) => m.role === "assistant" && !m.synthetic && !m.superseded)
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n"),
    )
    .join("\n");
  const result = new Map<string, NativeReplyLink>();
  const add = (kind: string, id: string, label: string) => {
    if (!safeId.test(id)) return;
    const url = `tandem://${kind}/${id}`;
    result.set(url, { url, label });
  };
  const scoped = tasks.filter((t) => t.repoPath === repoPath);
  for (const task of scoped) {
    if (explicitReference(text, "task", task.id) || mentioned(text, `tandem://task/${task.id}`))
      add("task", task.id, `Task ${task.id}`);
  }
  for (const brief of briefs.filter((b) => b.repoPath === repoPath)) {
    if (mentioned(text, brief.id)) add("brief", brief.id, `Brief ${brief.id}`);
  }
  // A number is clickable only when exactly one task in this project owns that PR.
  const prs = new Map<number, { count: number; url: string }>();
  for (const task of scoped) {
    const number = task.pullRequest?.number ?? task.prReview?.ref.number;
    if (number === undefined) continue;
    const url =
      task.pullRequest?.url ??
      (task.prReview ? `https://github.com/${task.prReview.ref.repo}/pull/${number}` : "");
    prs.set(number, { count: (prs.get(number)?.count ?? 0) + 1, url });
  }
  for (const [number, pr] of prs) {
    if (
      pr.count === 1 &&
      (explicitReference(text, "(?:PR|pull request)", String(number)) ||
        mentioned(text, `tandem://pr/${number}`) ||
        mentioned(text, pr.url))
    )
      add("pr", String(number), `PR #${number}`);
  }
  return [...result.values()];
}

/** Labels and routes are built above from durable ids; controls cannot escape OSC framing. */
export function nativeLinkLine(links: readonly NativeReplyLink[]): string {
  return links.map((link) => `\x1b]8;;${link.url}\x1b\\${link.label}\x1b]8;;\x1b\\`).join(" · ");
}
