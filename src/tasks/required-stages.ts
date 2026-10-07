import type { RequiredStages, TaskRecord } from "../contracts.ts";
import { isUnvalidatedPolicy } from "./acceptance.ts";

/** What an implementation task's required stages depend on, gathered when it is created or steered. */
export type RequiredStageFacts = Readonly<{
  /** The request's approved brief says this work needs no code review. */
  readonly briefSkipsReview: boolean;
  /**
   * The task's pull request is published (open, not a draft). A follow-up on it goes straight
   * back to the pull request, whose own CI checks it.
   */
  readonly pullRequestPublished: boolean;
  /**
   * The pinned policy is the project's deliberate "no checks" (`validation = "none"`). Validation
   * is skipped and review always runs, so at least one gate stands.
   */
  readonly unvalidated: boolean;
}>;

/**
 * The one place that decides which stages an implementation task runs after implementation.
 * Tandem pushes the work once these pass, right away when none are required.
 *
 * | Situation                          | validation | review |
 * | ---------------------------------- | ---------- | ------ |
 * | Normal new task                    | yes        | yes    |
 * | Brief approved with "skip review"  | yes        | no     |
 * | Project chose no checks            | no         | yes    |
 * | Steering a task whose PR is open   | no         | no     |
 */
export function decideRequiredStages(facts: RequiredStageFacts): RequiredStages {
  if (facts.pullRequestPublished) return { validation: false, review: false };
  if (facts.unvalidated) return { validation: false, review: true };
  return { validation: true, review: !facts.briefSkipsReview };
}

/** The required-stage facts that come from the task's own pinned policy. */
export function policyStageFacts(
  task: Pick<TaskRecord, "policy">,
): Pick<RequiredStageFacts, "unvalidated"> {
  return { unvalidated: isUnvalidatedPolicy(task.policy.config) };
}

/** Whether the task's pull request is published, the fact steering re-reads. */
export function pullRequestPublished(task: Pick<TaskRecord, "pullRequest">): boolean {
  return task.pullRequest?.state === "open";
}

/**
 * The task's recorded required stages. A record saved before they existed derives them from its
 * own pull request and pinned policy; the service backfills the brief's part on its next tick.
 */
export function requiredStagesOf(
  task: Pick<TaskRecord, "requiredStages" | "pullRequest" | "policy">,
): RequiredStages {
  return (
    task.requiredStages ??
    decideRequiredStages({
      briefSkipsReview: false,
      pullRequestPublished: pullRequestPublished(task),
      ...policyStageFacts(task),
    })
  );
}
