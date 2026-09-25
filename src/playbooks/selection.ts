import type { PinnablePlaybookId, PlaybookId } from "./catalog.ts";

/** The job types Jev chooses between; `other` pins the general playbook. */
export const JOB_TYPES = ["bug-fix", "feature", "refactor", "perf", "other"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** A Jev pick below this confidence falls back to the general playbook. */
export const PLAYBOOK_CONFIDENCE_THRESHOLD = 0.8;

/** The playbook a classifier pick pins; no pick, `other`, or a low-confidence pick pins `general`. */
export function selectPlaybook(
  pick: Readonly<{ readonly jobType: JobType; readonly confidence: number }> | undefined,
): PinnablePlaybookId {
  if (pick === undefined || pick.confidence < PLAYBOOK_CONFIDENCE_THRESHOLD) return "general";
  return pick.jobType === "other" ? "general" : pick.jobType;
}

/**
 * The playbook one implementer run follows: every fix round follows `fix-round`, otherwise the
 * task's pinned playbook. Tasks created before playbooks existed pin none.
 */
export function playbookForRun(
  pinned: PlaybookId | undefined,
  fixRound: boolean,
): PlaybookId | undefined {
  return fixRound ? "fix-round" : pinned;
}
