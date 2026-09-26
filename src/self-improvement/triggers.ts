import type { StoredTimelineEvent } from "../tasks/timeline.ts";

/** Why a task is worth looking into: fixed rules over its timeline, never a model's judgement. */
export type InvestigationTrigger = "restarts" | "fix-rounds" | "blocked";

export const RESTARTS_BEFORE_ASKING = 2;
export const FIX_ROUNDS_BEFORE_ASKING = 3;
export const BLOCKED_MS_BEFORE_ASKING = 60 * 60 * 1_000;

/**
 * The first rule a task's timeline breaks: restarted twice, three or more fix rounds, or one block
 * lasting over an hour, counting a block still open at `now`.
 */
export function investigationTrigger(
  events: readonly StoredTimelineEvent[],
  now: Date,
): InvestigationTrigger | undefined {
  const restarts = events.filter((event) => event.type === "restarted").length;
  if (restarts >= RESTARTS_BEFORE_ASKING) return "restarts";
  const fixRounds = events.filter((event) => event.type === "fix-round").length;
  if (fixRounds >= FIX_ROUNDS_BEFORE_ASKING) return "fix-rounds";
  if (longestBlockMs(events, now) > BLOCKED_MS_BEFORE_ASKING) return "blocked";
  return undefined;
}

/** What happened, in words the question to the user can end with. */
export function describeTrigger(trigger: InvestigationTrigger): string {
  switch (trigger) {
    case "restarts":
      return "has restarted twice";
    case "fix-rounds":
      return "needed three or more rounds of fixes after review";
    case "blocked":
      return "was stuck for over an hour";
  }
}

function longestBlockMs(events: readonly StoredTimelineEvent[], now: Date): number {
  let longest = 0;
  let blockedAt: number | undefined;
  for (const event of events) {
    if (event.type === "blocked") blockedAt ??= Date.parse(event.at);
    if (event.type === "unblocked" && blockedAt !== undefined) {
      longest = Math.max(longest, Date.parse(event.at) - blockedAt);
      blockedAt = undefined;
    }
  }
  return blockedAt === undefined ? longest : Math.max(longest, now.getTime() - blockedAt);
}
