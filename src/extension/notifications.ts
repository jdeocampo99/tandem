import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskRecord } from "../contracts.ts";
import type { TandemService } from "../service/controller.ts";
import { decideResearchFollowUp } from "../tasks/research-continuation.ts";
import { buildResearchFollowUpContent } from "./research-follow-up.ts";
import { ACTION_SUMMARY_MAX_TEXT, compactText, prioritizeTasks } from "./summary.ts";

const MAX_NOTIFICATION_BATCH = 8;
const TANDEM_NOTIFICATION_ENTRY = "tandem-notification";
/** A finished research report up to this size rides along with its wake, saving a read call. */
export const INLINE_RESEARCH_REPORT_MAX_CHARS = 16_000;

/**
 * The text of a recorded report, or undefined when it cannot be read. Reading it is also the proof
 * the follow-up decision needs that the report is still there.
 */
export type ResearchReportReader = (reportPath: string) => Promise<string | undefined>;

type NotificationRef = Readonly<{
  readonly taskId: string;
  readonly notificationId: string;
  readonly message: string;
  readonly judgmentNeeded: boolean;
  readonly questionId?: string;
  readonly questionText?: string;
  readonly recommendation?: string;
  readonly reportPath?: string;
  readonly followUp?: string;
  /** The research report's full text, when the follow-up asks for a summary and it is short enough. */
  readonly reportText?: string;
}>;

type ResearchWake = Readonly<{ readonly followUp: string; readonly reportText?: string }>;

export async function readResearchReport(reportPath: string): Promise<string | undefined> {
  try {
    return await readFile(reportPath, "utf8");
  } catch {
    return undefined;
  }
}

function taskNeedsCoordinatorJudgment(task: Pick<TaskRecord, "kind" | "stage">): boolean {
  if (task.stage === "blocked") return true;
  return task.kind === "scout" && task.stage === "completed";
}

/** A finished scout's follow-up, with its report attached when the coordinator must summarize it. */
async function researchWake(
  task: TaskRecord,
  readReport: ResearchReportReader,
): Promise<ResearchWake | undefined> {
  if (task.kind !== "scout") return undefined;
  const reportText = task.reportPath === undefined ? undefined : await readReport(task.reportPath);
  const decision = decideResearchFollowUp({ task, reportReadable: reportText !== undefined });
  const followUp = buildResearchFollowUpContent(decision);
  const summarizes =
    decision.followUp === "report-only" ||
    decision.followUp === "ask-intent" ||
    decision.followUp === "implementation-interview";
  return summarizes &&
    reportText !== undefined &&
    reportText.length <= INLINE_RESEARCH_REPORT_MAX_CHARS
    ? { followUp, reportText }
    : { followUp };
}

async function allPendingNotifications(
  tasks: readonly TaskRecord[],
  readReport: ResearchReportReader,
): Promise<readonly NotificationRef[]> {
  const result: NotificationRef[] = [];
  for (const task of prioritizeTasks(tasks)) {
    const pending = task.notifications.filter((notification) => !notification.acknowledged);
    if (pending.length === 0) continue;
    let latestLegacyId: string | undefined;
    for (let index = task.notifications.length - 1; index >= 0; index -= 1) {
      const notification = task.notifications[index];
      if (notification !== undefined && notification.kind === undefined) {
        latestLegacyId = notification.id;
        break;
      }
    }
    let wake: ResearchWake | undefined;
    for (const notification of pending) {
      const judgmentNeeded =
        notification.kind === "coordinator" ||
        (notification.kind === undefined &&
          taskNeedsCoordinatorJudgment(task) &&
          notification.id === latestLegacyId);
      const question = judgmentNeeded ? task.communication?.question : undefined;
      if (judgmentNeeded) wake ??= await researchWake(task, readReport);
      result.push({
        taskId: task.id,
        notificationId: notification.id,
        message: notification.message,
        judgmentNeeded,
        ...(question === undefined
          ? {}
          : {
              questionId: question.id,
              questionText: question.text,
              ...(question.recommendation === undefined
                ? {}
                : { recommendation: question.recommendation }),
            }),
        ...(judgmentNeeded && task.reportPath !== undefined ? { reportPath: task.reportPath } : {}),
        ...(judgmentNeeded && wake !== undefined ? { followUp: wake.followUp } : {}),
        ...(judgmentNeeded && wake?.reportText !== undefined
          ? { reportText: wake.reportText }
          : {}),
      });
    }
  }
  return result;
}
/** Identifies one notification across ticks, so a delivered wake is never repeated. */
function deliveryKey(notification: NotificationRef): string {
  return `${notification.taskId}:${notification.notificationId}`;
}

/** Routine (non-judgment) notifications: informational only, so the task id stays as a label. */
function notificationContent(notifications: readonly NotificationRef[]): string {
  return notifications
    .map((notification) => {
      const lines = [
        `[${notification.taskId}] ${compactText(notification.message, ACTION_SUMMARY_MAX_TEXT)}`,
      ];
      if (notification.questionId !== undefined) {
        lines.push(
          `Question ${compactText(notification.questionId, 100)}: ${compactText(notification.questionText ?? "text unavailable", ACTION_SUMMARY_MAX_TEXT)}`,
        );
        if (notification.recommendation !== undefined)
          lines.push(
            `Recommendation: ${compactText(notification.recommendation, ACTION_SUMMARY_MAX_TEXT)}`,
          );
      }
      if (notification.reportPath !== undefined)
        lines.push(`Evidence report: ${compactText(notification.reportPath, 180)}`);
      if (notification.followUp !== undefined) lines.push(notification.followUp);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Judgment-needed notifications shown to the user: no task, notification, or question id in the
 * text. The same ids, needed for the model to act, travel separately through
 * {@link judgmentIdentifiers} on a message the user never sees.
 */
function judgmentDisplayContent(notifications: readonly NotificationRef[]): string {
  return notifications
    .map((notification) => {
      const lines = [compactText(notification.message, ACTION_SUMMARY_MAX_TEXT)];
      if (notification.questionText !== undefined) {
        lines.push(compactText(notification.questionText, ACTION_SUMMARY_MAX_TEXT));
        if (notification.recommendation !== undefined)
          lines.push(
            `Recommendation: ${compactText(notification.recommendation, ACTION_SUMMARY_MAX_TEXT)}`,
          );
      }
      if (notification.reportPath !== undefined)
        lines.push(`Evidence report: ${compactText(notification.reportPath, 180)}`);
      if (notification.followUp !== undefined) lines.push(notification.followUp);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * The task/request and question ids the displayed judgment-needed text just left out, in the same
 * order, for a tool call to act on. Sent as a `display: false` companion message: it still reaches
 * the model's context (a custom message's `content` is converted to LLM history regardless of
 * `display`), but the host transcript never renders it, so the user never sees an id.
 */
function judgmentIdentifiers(notifications: readonly NotificationRef[]): string {
  const lines = notifications.map((notification) => {
    const ref = `task ${notification.taskId}, notification ${notification.notificationId}`;
    return notification.questionId === undefined
      ? ref
      : `${ref}, question ${notification.questionId}`;
  });
  const reports = notifications.flatMap((notification) =>
    notification.reportText === undefined
      ? []
      : [
          "",
          `Full report for task ${notification.taskId}; it is already here, so do not read the file:`,
          notification.reportText,
        ],
  );
  return [
    "Identifiers for the item(s) above, in the same order (never display or repeat these to the user):",
    ...lines,
    ...reports,
  ].join("\n");
}

type NotificationMessageSink = Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
type NotificationUi = Readonly<{ readonly ui: Pick<ExtensionContext["ui"], "notify"> }>;

export type PendingNotificationDelivery = Readonly<{
  readonly pi: NotificationMessageSink;
  readonly service: Pick<TandemService, "acknowledge">;
  readonly tasks: readonly TaskRecord[];
  /** Task/notification pairs already sent in this process, so one wake is not repeated. */
  readonly delivered: Set<string>;
  /**
   * Sent pairs whose acknowledgement has not been recorded yet. A lost state-lock race leaves the
   * pair here for a later tick instead of re-sending a wake the coordinator has already read.
   */
  readonly unacknowledged: Set<string>;
  readonly ctx: NotificationUi;
  readonly readReport: ResearchReportReader;
}>;

/** Deliver pending notifications without turning routine scheduler work into model input. */
export async function deliverPendingNotifications(
  delivery: PendingNotificationDelivery,
): Promise<void> {
  const { pi, tasks, delivered, unacknowledged, ctx } = delivery;
  const pending = await allPendingNotifications(tasks, delivery.readReport);
  if (pending.length === 0) return;
  const batch = pending
    .filter((notification) => !delivered.has(deliveryKey(notification)))
    .slice(0, MAX_NOTIFICATION_BATCH);
  const actionable = batch.filter((notification) => notification.judgmentNeeded);
  const routine = batch.filter((notification) => !notification.judgmentNeeded);
  for (const notification of batch) {
    delivered.add(deliveryKey(notification));
    unacknowledged.add(deliveryKey(notification));
  }
  try {
    if (routine.length > 0) {
      const content = notificationContent(routine);
      ctx.ui.notify(content, "info");
      pi.appendEntry(TANDEM_NOTIFICATION_ENTRY, { notifications: routine, content });
    }
    if (actionable.length > 0) {
      // The identifiers land in context first (hidden), then the clean prompt the user reads;
      // only the second call triggers the turn, so the model responds once with both in hand.
      pi.sendMessage(
        {
          customType: TANDEM_NOTIFICATION_ENTRY,
          content: judgmentIdentifiers(actionable),
          display: false,
          details: { notifications: actionable },
          attribution: "agent",
        },
        { deliverAs: "followUp" },
      );
      pi.sendMessage(
        {
          customType: TANDEM_NOTIFICATION_ENTRY,
          content: judgmentDisplayContent(actionable),
          display: true,
          attribution: "agent",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  } catch (error) {
    for (const notification of batch) {
      delivered.delete(deliveryKey(notification));
      unacknowledged.delete(deliveryKey(notification));
    }
    throw error;
  }
  await acknowledgeDelivered(delivery, pending);
}

/**
 * Records the acknowledgement of every notification already shown in this process, including ones
 * whose acknowledgement lost a state-lock race on an earlier tick. The message has already reached
 * the coordinator, so a failure here waits for the next tick rather than waking it a second time
 * for something it has read.
 */
async function acknowledgeDelivered(
  delivery: PendingNotificationDelivery,
  pending: readonly NotificationRef[],
): Promise<void> {
  const { service, unacknowledged } = delivery;
  for (const notification of pending) {
    const key = deliveryKey(notification);
    if (!unacknowledged.has(key)) continue;
    try {
      await service.acknowledge(notification.taskId, notification.notificationId);
      unacknowledged.delete(key);
    } catch {
      // ponytail: one contended state lock fails the rest of the pass too, so stop here and retry
      // on the next tick. Acknowledge each notification independently if a non-contention failure
      // ever needs to be isolated from its neighbours.
      return;
    }
  }
}
