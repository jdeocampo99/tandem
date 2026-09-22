import type {
  Clock,
  IdFactory,
  IsoTimestamp,
  Notification,
  TaskQuestion,
  TaskRecord,
} from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState, updateRuntimeState } from "../runtime/persistence.ts";
import type { RuntimeTaskState } from "../runtime/schema.ts";
import { isTerminalTask, replaceRuntimeTask } from "../service/records.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import { formatDecisionQuestion } from "../tasks/question.ts";
import type { TaskStore } from "../tasks/store.ts";
import {
  chooseRecoveryAction,
  classifyRecoveryEvidence,
  preapprovedRecoveryAction,
  RECOVERY_QUESTION_ID_PREFIX,
  type RecoveryActionName,
  type RecoveryDecisionReceipt,
  type RecoveryDisposition,
  type RecoveryEvidence,
  type RecoveryProvenFacts,
  type UnattendedRecoveryActionName,
} from "./decision.ts";
import {
  AVAILABILITY_WAIT_CEILING_MS,
  type AvailabilityWaitDisposition,
  decideAvailabilityWait,
  millisecondsAt,
  type RecoveryAvailabilityWait,
  supersededWaitReason,
} from "./wait.ts";
import type {
  EvidenceRepairResult,
  ReconciliationResult,
  RecoveryInspection,
  RecoveryPlan,
} from "./workflow.ts";

/** The existing recovery entry points conversational recovery is allowed to drive. */
export type SupportedRecoveryActions = Readonly<{
  readonly inspect: (taskId: string) => Promise<RecoveryInspection>;
  readonly plan: (taskId: string) => Promise<RecoveryPlan>;
  readonly reconcile: (taskId: string, approved: boolean) => Promise<ReconciliationResult>;
  readonly repairEvidence: (taskId: string, approved: boolean) => Promise<EvidenceRepairResult>;
}>;

export type RecoveryConversationDependencies = Readonly<{
  readonly sessionId: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly recovery: SupportedRecoveryActions;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  /** Why the request governing this task holds its work, or undefined when nothing holds it. */
  readonly requestDispatchHold: (
    task: Pick<TaskRecord, "requestId">,
  ) => Promise<string | undefined>;
}>;

/** What one conversational recovery pass settled, and whether it changed any durable state. */
export type RecoveryConversationOutcome = Readonly<{
  readonly taskId: string;
  readonly requestId?: string;
  readonly status: RecoveryDisposition;
  readonly changed: boolean;
  readonly decision?: RecoveryDecisionReceipt;
  readonly wait?: RecoveryAvailabilityWait;
}>;

/** Keeps the durable receipt list bounded while the most recent decisions stay inspectable. */
const MAX_RECOVERY_DECISION_RECEIPTS = 10;

const QUESTION_ID_PREFIX = RECOVERY_QUESTION_ID_PREFIX;

type DecisionDraft = Omit<RecoveryDecisionReceipt, "schemaVersion" | "id" | "decidedAt">;

function questionIdFor(evidence: RecoveryEvidence): string {
  return `${QUESTION_ID_PREFIX}${evidence.identity}`;
}

function durableBlockers(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): readonly string[] {
  return [
    task.blockReason,
    runtime?.lastError,
    ...(runtime?.jobs ?? []).map((job) => job.error),
    runtime?.operation?.error,
  ].filter((entry): entry is string => typeof entry === "string");
}

function waitFor(
  runtime: RuntimeTaskState | undefined,
  evidenceIdentity: string,
): RecoveryAvailabilityWait | undefined {
  return (runtime?.recoveryWaits ?? []).find(
    (entry) => entry.evidenceIdentity === evidenceIdentity,
  );
}

function withWait(
  waits: readonly RecoveryAvailabilityWait[],
  next: RecoveryAvailabilityWait,
): readonly RecoveryAvailabilityWait[] {
  const replaced = waits.map((entry) =>
    entry.evidenceIdentity === next.evidenceIdentity ? next : entry,
  );
  return replaced.some((entry) => entry.evidenceIdentity === next.evidenceIdentity)
    ? replaced
    : [...waits, next];
}

function settledWait(
  wait: RecoveryAvailabilityWait,
  disposition: AvailabilityWaitDisposition,
  reason: string,
): RecoveryAvailabilityWait {
  return { ...wait, disposition, dispositionReason: reason };
}

/** A wake is due only once the recorded deadline has passed; before that nothing is inspected. */
function waitIsDue(wait: RecoveryAvailabilityWait, now: IsoTimestamp): boolean {
  const deadlineMs = millisecondsAt(wait.deadlineAt);
  const nowMs = millisecondsAt(now);
  return deadlineMs === undefined || nowMs === undefined || nowMs >= deadlineMs;
}

function questionText(
  evidence: RecoveryEvidence,
  recommendedAction: RecoveryActionName | undefined,
  consequences: string,
): string {
  const want =
    recommendedAction === undefined
      ? `Nothing yet: no supported recovery action is proven safe, so I am asking before touching anything. ${consequences}`
      : `Run ${recommendedAction}. ${consequences}`;
  return formatDecisionQuestion({
    what: `A task is blocked: ${evidence.summary}.`,
    recommendation: want,
    risk: "Nothing has changed yet; the worktree, reports, provenance, and unmerged changes are preserved either way.",
  });
}

/** Identifiers belong only in the recommendation's details, never in the plain-English question text. */
function recoveryQuestionDetails(task: TaskRecord): string {
  return `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}.`;
}

/**
 * Blocks a task on a durable question without appending a worker-instruction message, so answering
 * it never bumps `task.communication.revision`. Exported for the central recovery module's own
 * restart question, which follows the exact same shape.
 */
export function taskAsking(
  task: TaskRecord,
  question: TaskQuestion,
  notificationId: string,
  now: IsoTimestamp,
): TaskRecord {
  const blocked = ["cancelled", "completed", "merged", "paused", "blocked"].includes(task.stage)
    ? task
    : transitionTask(task, { type: "block", reason: question.text }, { now, notificationId });
  const notification: Notification = {
    id: notificationId,
    message: question.text,
    acknowledged: false,
    kind: "coordinator",
  };
  const notifications =
    blocked === task
      ? [...task.notifications, notification]
      : blocked.notifications.map((entry) =>
          entry.id === notificationId ? { ...entry, kind: "coordinator" as const } : entry,
        );
  return {
    ...blocked,
    revision: task.revision + 1,
    updatedAt: now,
    notifications,
    communication: { ...(blocked.communication ?? { revision: 0, messages: [] }), question },
  };
}

/**
 * Decides what a recovery-worthy blocker should lead to, and carries out only what the preapproval
 * policy already covers. Every mutation goes through the existing recovery entry points, so their
 * locks, ownership checks, budgets, and quarantine behavior still decide the result.
 */
export class RecoveryConversationWorkflow {
  readonly #deps: RecoveryConversationDependencies;

  public constructor(deps: RecoveryConversationDependencies) {
    this.#deps = deps;
  }

  /** Reads durable state for one task and settles its current recovery decision. */
  public async decide(taskId: string): Promise<RecoveryConversationOutcome> {
    const task = await this.#deps.getTask(taskId);
    if (isTerminalTask(task)) {
      return { taskId, status: "none", changed: false };
    }
    const runtime = taskRuntime(await readRuntimeState(this.#deps.runtimePath), taskId);
    const evidence = classifyRecoveryEvidence({
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      blockers: durableBlockers(task, runtime),
      observedAt: this.#deps.clock(),
      ...(task.blockCause === undefined ? {} : { cause: task.blockCause }),
    });
    if (evidence === undefined) return { taskId, status: "none", changed: false };
    if (evidence.kind !== "temporary-availability") {
      return this.settleThroughDecisionRules(task, evidence);
    }
    return this.settleThroughWaitRules(task, runtime, evidence);
  }

  /**
   * Wakes only the waits whose deadline has passed, so routine scheduler passes read durable state
   * and stop. A wake never launches work by itself: it re-inspects once and then follows the same
   * decision rules, which is the only path that can change anything.
   */
  public async reconcileWaits(
    tasks: readonly TaskRecord[],
  ): Promise<readonly RecoveryConversationOutcome[]> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const now = this.#deps.clock();
    const outcomes: RecoveryConversationOutcome[] = [];
    for (const runtime of state.tasks) {
      const task = tasks.find((entry) => entry.id === runtime.taskId);
      for (const wait of runtime.recoveryWaits ?? []) {
        if (wait.disposition !== "waiting") continue;
        const superseded = supersededWaitReason(wait, task);
        if (superseded !== undefined) {
          outcomes.push(await this.abandonWait(runtime.taskId, wait, superseded));
          continue;
        }
        if (!waitIsDue(wait, now)) continue;
        const outcome = await this.decide(runtime.taskId);
        outcomes.push(
          outcome.wait?.evidenceIdentity === wait.evidenceIdentity
            ? outcome
            : await this.abandonWait(
                runtime.taskId,
                wait,
                "the durable evidence that started this wait is no longer recorded",
              ),
        );
      }
    }
    return outcomes;
  }

  /**
   * Answers a durable evidence-based recovery question (never a restart question, which the central
   * recovery module owns). Clears the question and records the free-text reply as a decision receipt
   * without ever calling `appendTaskMessage`: a recovery answer is a decision, never a worker
   * instruction, so `task.communication.revision` is left exactly as it was. The task may still
   * resume from `blocked` the same way answering any question does; nothing here applies an action
   * by itself, since a plain-text reply does not carry the parameters some recovery actions need.
   */
  public async answerQuestion(
    taskId: string,
    questionId: string,
    text: string,
  ): Promise<Readonly<{ readonly changed: boolean; readonly resumed: boolean }>> {
    const task = await this.#deps.getTask(taskId);
    if (task.communication?.question?.id !== questionId) return { changed: false, resumed: false };
    const runtime = taskRuntime(await readRuntimeState(this.#deps.runtimePath), taskId);
    const priorDecision = (runtime?.recoveryDecisions ?? []).find(
      (entry) => entry.questionId === questionId,
    );
    let changed = false;
    let resumed = false;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.communication?.question?.id !== questionId) return;
      const { question: _question, ...withoutQuestion } = current.communication ?? {
        revision: 0,
        messages: [],
      };
      const updated = await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: this.#deps.clock(),
        communication: withoutQuestion,
      }));
      changed = true;
      resumed =
        updated.stage === "blocked" &&
        updated.previousStage !== undefined &&
        updated.previousStage !== "paused" &&
        updated.previousStage !== "blocked";
    });
    if (changed && priorDecision !== undefined) {
      await this.saveDecision(taskId, {
        taskId,
        generation: priorDecision.generation,
        ...(priorDecision.requestId === undefined ? {} : { requestId: priorDecision.requestId }),
        evidence: priorDecision.evidence,
        ownership: priorDecision.ownership,
        priorOutcome: priorDecision.priorOutcome,
        ...(priorDecision.recommendedAction === undefined
          ? {}
          : { recommendedAction: priorDecision.recommendedAction }),
        approval: priorDecision.approval,
        unmetProofs: priorDecision.unmetProofs,
        consequences: priorDecision.consequences,
        disposition: "refused",
        dispositionReason: `the user answered without invoking a recovery action: ${text}`.slice(
          0,
          500,
        ),
        questionId,
      });
    }
    return { changed, resumed };
  }

  private async abandonWait(
    taskId: string,
    wait: RecoveryAvailabilityWait,
    reason: string,
  ): Promise<RecoveryConversationOutcome> {
    const settled = settledWait(wait, "abandoned", reason);
    await this.saveWait(taskId, settled);
    return {
      taskId,
      ...(wait.requestId === undefined ? {} : { requestId: wait.requestId }),
      status: "none",
      changed: true,
      wait: settled,
    };
  }

  private async settleThroughWaitRules(
    task: TaskRecord,
    runtime: RuntimeTaskState | undefined,
    evidence: RecoveryEvidence,
  ): Promise<RecoveryConversationOutcome> {
    const existing = waitFor(runtime, evidence.identity);
    const now = this.#deps.clock();
    const decision = decideAvailabilityWait({
      now,
      observerSessionId: this.#deps.sessionId,
      evidence,
      ...(existing === undefined ? {} : { existing }),
      ceilingMs: AVAILABILITY_WAIT_CEILING_MS,
    });
    if (decision.kind === "settled") {
      return {
        taskId: task.id,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        status: "none",
        changed: false,
        ...(existing === undefined ? {} : { wait: existing }),
      };
    }
    if (decision.kind === "hold-wait") {
      return {
        taskId: task.id,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        status: "waiting",
        changed: false,
        ...(existing === undefined ? {} : { wait: existing }),
      };
    }
    if (decision.kind === "start-wait") {
      const started: RecoveryAvailabilityWait = {
        schemaVersion: 1,
        taskId: task.id,
        generation: task.generation,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        evidenceIdentity: evidence.identity,
        evidenceSummary: evidence.summary,
        ownerSessionId: this.#deps.sessionId,
        startedAt: now,
        deadlineAt: decision.deadlineAt,
        ...(evidence.knownAvailableAt === undefined
          ? {}
          : { knownAvailableAt: evidence.knownAvailableAt }),
        disposition: "waiting",
        dispositionReason: decision.reason,
      };
      await this.saveWait(task.id, started);
      const receipt = await this.saveDecision(task.id, {
        taskId: task.id,
        generation: task.generation,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        evidence,
        ownership: "proven-owned",
        priorOutcome: "known",
        approval: "preapproved",
        unmetProofs: [],
        consequences: `No work is launched while the wait holds; it ends at ${decision.deadlineAt} at the latest.`,
        disposition: "waiting",
        dispositionReason: decision.reason,
      });
      return {
        taskId: task.id,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        status: "waiting",
        changed: true,
        decision: receipt,
        wait: started,
      };
    }
    if (decision.kind === "ask-now" || existing === undefined) {
      const asked = await this.settleThroughDecisionRules(task, evidence, decision.reason);
      const wait = settledWait(
        existing ?? this.lapsedWait(task, evidence, now, decision.reason),
        "asked",
        decision.reason,
      );
      await this.saveWait(task.id, wait);
      return { ...asked, wait };
    }
    await this.saveWait(task.id, { ...existing, reinspectedAt: now });
    const continued = await this.settleThroughDecisionRules(task, evidence);
    const wait = settledWait({ ...existing, reinspectedAt: now }, "continued", decision.reason);
    await this.saveWait(task.id, wait);
    return { ...continued, wait };
  }

  /**
   * The single decision path: re-read the durable plan, classify ownership and the prior outcome,
   * and either run a fully proved preapproved action or ask exactly one bounded question.
   */
  private async settleThroughDecisionRules(
    task: TaskRecord,
    evidence: RecoveryEvidence,
    waitReason?: string,
  ): Promise<RecoveryConversationOutcome> {
    if (!(await this.#deps.taskInScope(task))) {
      return this.refuseOutOfScope(task, evidence);
    }
    const plan = await this.#deps.recovery.plan(task.id);
    const ownership = plan.ownership;
    const priorOutcome = plan.priorOutcome;
    const facts = await this.provenFacts({ task, plan });
    const choice = chooseRecoveryAction({
      plannedAction: plan.operation.name,
      plannedEffect: plan.operation.effect,
      planRefusals: plan.refusals,
      facts,
      budget: {
        recoveryAttempts: plan.budget.recoveryRemaining,
        validationRetries: plan.budget.validationRetriesRemaining,
        evidenceRepairs: plan.budget.evidenceRepairsRemaining,
      },
    });
    const draft: DecisionDraft = {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence,
      ownership,
      priorOutcome,
      ...(choice.recommendedAction === undefined
        ? {}
        : { recommendedAction: choice.recommendedAction }),
      approval: choice.approval,
      unmetProofs: choice.unmetProofs,
      consequences: choice.consequences,
      disposition: "asked",
      dispositionReason: waitReason ?? "a fresh decision is required before anything is changed",
    };
    const preapproved =
      choice.recommendedAction === undefined
        ? undefined
        : preapprovedRecoveryAction(choice.recommendedAction);
    if (choice.approval === "preapproved" && preapproved !== undefined) {
      return this.applyPreapproved(task, preapproved.action, draft);
    }
    return this.ask(task, evidence, draft);
  }

  /**
   * `plan()` is the single planner and already proved every fact it can prove; this only supplies
   * the one fact it cannot (`request-approval-current`, which needs the request brief this module
   * alone has access to). Nothing here reclassifies ownership, prior outcome, or any other proof.
   */
  private async provenFacts(
    input: Readonly<{ readonly task: TaskRecord; readonly plan: RecoveryPlan }>,
  ): Promise<RecoveryProvenFacts> {
    const requestHold = await this.#deps.requestDispatchHold(input.task);
    return { ...input.plan.facts, "request-approval-current": requestHold === undefined };
  }

  private async applyPreapproved(
    task: TaskRecord,
    action: UnattendedRecoveryActionName,
    draft: DecisionDraft,
  ): Promise<RecoveryConversationOutcome> {
    const applied = await this.runSupportedAction(task.id, action);
    const receipt = await this.saveDecision(task.id, {
      ...draft,
      disposition: applied.changed ? "applied" : "refused",
      dispositionReason: applied.reason,
    });
    return {
      taskId: task.id,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      status: receipt.disposition,
      changed: applied.changed,
      decision: receipt,
    };
  }

  /** Runs one preapproved action through its existing entry point and reports what it did. */
  private async runSupportedAction(
    taskId: string,
    action: UnattendedRecoveryActionName,
  ): Promise<Readonly<{ readonly changed: boolean; readonly reason: string }>> {
    if (action === "reconcile") {
      const result = await this.#deps.recovery.reconcile(taskId, true);
      return {
        changed: result.changed,
        reason: result.reasons.join("; ") || "no proven stale resource was found",
      };
    }
    const result = await this.#deps.recovery.repairEvidence(taskId, true);
    return {
      changed: result.changed,
      reason:
        result.reason ?? `repaired ${result.repairedPaths.length} durable report evidence path(s)`,
    };
  }

  private async ask(
    task: TaskRecord,
    evidence: RecoveryEvidence,
    draft: DecisionDraft,
  ): Promise<RecoveryConversationOutcome> {
    const recommendationPrefix =
      draft.recommendedAction === undefined
        ? draft.consequences
        : `${draft.recommendedAction}: ${draft.consequences}`;
    const question: TaskQuestion = {
      id: questionIdFor(evidence),
      text: questionText(evidence, draft.recommendedAction, draft.consequences),
      recommendation: `${recommendationPrefix} ${recoveryQuestionDetails(task)}`,
    };
    const asked = await this.recordQuestion(task.id, question);
    const receipt = await this.saveDecision(task.id, { ...draft, questionId: question.id });
    return {
      taskId: task.id,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      status: "asked",
      changed: asked,
      decision: receipt,
    };
  }

  /** A task outside the repository scope is reported without reading or writing its resources. */
  private refuseOutOfScope(
    task: TaskRecord,
    evidence: RecoveryEvidence,
  ): RecoveryConversationOutcome {
    return {
      taskId: task.id,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      status: "refused",
      changed: false,
      decision: {
        schemaVersion: 1,
        id: `${QUESTION_ID_PREFIX}${evidence.identity}-refused`,
        taskId: task.id,
        generation: task.generation,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        evidence,
        ownership: "unknown",
        priorOutcome: "uncertain",
        approval: "user-approval",
        unmetProofs: ["task-in-scope"],
        consequences: "No resource is inspected or changed.",
        disposition: "refused",
        dispositionReason: "the task is outside the repository scope",
        decidedAt: this.#deps.clock(),
      },
    };
  }

  private lapsedWait(
    task: TaskRecord,
    evidence: RecoveryEvidence,
    now: IsoTimestamp,
    reason: string,
  ): RecoveryAvailabilityWait {
    return {
      schemaVersion: 1,
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidenceIdentity: evidence.identity,
      evidenceSummary: evidence.summary,
      ownerSessionId: this.#deps.sessionId,
      startedAt: now,
      deadlineAt: now,
      ...(evidence.knownAvailableAt === undefined
        ? {}
        : { knownAvailableAt: evidence.knownAvailableAt }),
      disposition: "waiting",
      dispositionReason: reason,
    };
  }

  /** Records one bounded question, answering whether this call is the one that asked it. */
  private async recordQuestion(taskId: string, question: TaskQuestion): Promise<boolean> {
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || isTerminalTask(current)) return false;
      if (current.communication?.question?.id === question.id) return false;
      const asked = taskAsking(current, question, this.#deps.idFactory(), this.#deps.clock());
      await store.update(current.id, current.revision, () => asked);
      return true;
    });
  }

  private async saveDecision(
    taskId: string,
    draft: DecisionDraft,
  ): Promise<RecoveryDecisionReceipt> {
    const receipt: RecoveryDecisionReceipt = {
      schemaVersion: 1,
      id: `${QUESTION_ID_PREFIX}${draft.evidence.identity}-${draft.disposition}`,
      ...draft,
      decidedAt: this.#deps.clock(),
    };
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        recoveryDecisions: [
          ...(entry.recoveryDecisions ?? []).filter((existing) => existing.id !== receipt.id),
          receipt,
        ].slice(-MAX_RECOVERY_DECISION_RECEIPTS),
      })),
    );
    return receipt;
  }

  private async saveWait(taskId: string, wait: RecoveryAvailabilityWait): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        recoveryWaits: withWait(entry.recoveryWaits ?? [], wait),
      })),
    );
  }
}
