import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskRecord } from "../contracts.ts";
import type { TandemService } from "../service/controller.ts";
import { decideResearchFollowUp } from "../tasks/research-continuation.ts";
import { buildResearchFollowUpContent } from "./research-follow-up.ts";
import { ACTION_SUMMARY_MAX_TEXT, compactText, prioritizeTasks } from "./summary.ts";

const MAX_NOTIFICATION_BATCH = 8;
const TANDEM_NOTIFICATION_ENTRY = "tandem-notification";

/** Proof that a recorded report is still readable, so the follow-up decision may trust it. */
export type ResearchReportProbe = (reportPath: string) => Promise<boolean>;

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
}>;

export async function isResearchReportReadable(reportPath: string): Promise<boolean> {
  try {
    await access(reportPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function taskNeedsCoordinatorJudgment(task: Pick<TaskRecord, "kind" | "stage">): boolean {
  if (task.stage === "blocked") return true;
  return task.kind === "scout" && task.stage === "completed";
}

async function researchFollowUpContent(
  task: TaskRecord,
  reportReadable: ResearchReportProbe,
): Promise<string | undefined> {
  if (task.kind !== "scout") return undefined;
  const readable = task.reportPath !== undefined && (await reportReadable(task.reportPath));
  return buildResearchFollowUpContent(decideResearchFollowUp({ task, reportReadable: readable }));
}

async function allPendingNotifications(
  tasks: readonly TaskRecord[],
  reportReadable: ResearchReportProbe,
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
    let followUp: string | undefined;
    for (const notification of pending) {
      const judgmentNeeded =
        notification.kind === "coordinator" ||
        (notification.kind === undefined &&
          taskNeedsCoordinatorJudgment(task) &&
          notification.id === latestLegacyId);
      const question = judgmentNeeded ? task.communication?.question : undefined;
      if (judgmentNeeded) followUp ??= await researchFollowUpContent(task, reportReadable);
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
        ...(judgmentNeeded && followUp !== undefined ? { followUp } : {}),
      });
    }
  }
  return result;
}
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

type NotificationMessageSink = Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
type NotificationUi = Readonly<{ readonly ui: Pick<ExtensionContext["ui"], "notify"> }>;

export type PendingNotificationDelivery = Readonly<{
  readonly pi: NotificationMessageSink;
  readonly service: Pick<TandemService, "acknowledge">;
  readonly tasks: readonly TaskRecord[];
  /** Task/notification pairs already sent in this process, so one wake is not repeated. */
  readonly delivered: Set<string>;
  readonly ctx: NotificationUi;
  readonly reportReadable: ResearchReportProbe;
}>;

/** Deliver pending notifications without turning routine scheduler work into model input. */
export async function deliverPendingNotifications(
  delivery: PendingNotificationDelivery,
): Promise<void> {
  const { pi, service, tasks, delivered, ctx } = delivery;
  const pending = (await allPendingNotifications(tasks, delivery.reportReadable)).filter(
    (notification) => !delivered.has(`${notification.taskId}:${notification.notificationId}`),
  );
  if (pending.length === 0) return;
  const batch = pending.slice(0, MAX_NOTIFICATION_BATCH);
  const actionable = batch.filter((notification) => notification.judgmentNeeded);
  const routine = batch.filter((notification) => !notification.judgmentNeeded);
  for (const notification of batch)
    delivered.add(`${notification.taskId}:${notification.notificationId}`);
  try {
    if (routine.length > 0) {
      const content = notificationContent(routine);
      ctx.ui.notify(content, "info");
      pi.appendEntry(TANDEM_NOTIFICATION_ENTRY, { notifications: routine, content });
    }
    if (actionable.length > 0) {
      const content = notificationContent(actionable);
      pi.sendMessage(
        {
          customType: TANDEM_NOTIFICATION_ENTRY,
          content,
          display: true,
          details: { notifications: actionable },
          attribution: "agent",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
    for (const notification of batch) {
      await service.acknowledge(notification.taskId, notification.notificationId);
    }
  } catch (error) {
    for (const notification of batch)
      delivered.delete(`${notification.taskId}:${notification.notificationId}`);
    throw error;
  }
}
