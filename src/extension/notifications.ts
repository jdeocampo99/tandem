import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskRecord } from "../contracts.ts";
import type { TandemService } from "../service/controller.ts";
import { ACTION_SUMMARY_MAX_TEXT, compactText, prioritizeTasks } from "./summary.ts";

const MAX_NOTIFICATION_BATCH = 8;
const TANDEM_NOTIFICATION_ENTRY = "tandem-notification";

type NotificationRef = Readonly<{
  readonly taskId: string;
  readonly notificationId: string;
  readonly message: string;
  readonly judgmentNeeded: boolean;
}>;

function taskNeedsCoordinatorJudgment(task: Pick<TaskRecord, "kind" | "stage">): boolean {
  if (task.stage === "blocked") return true;
  return task.kind === "scout" && task.stage === "completed";
}

function allPendingNotifications(tasks: readonly TaskRecord[]): readonly NotificationRef[] {
  const result: NotificationRef[] = [];
  for (const task of prioritizeTasks(tasks)) {
    const pending = task.notifications.filter((notification) => !notification.acknowledged);
    let latestLegacyId: string | undefined;
    for (let index = task.notifications.length - 1; index >= 0; index -= 1) {
      const notification = task.notifications[index];
      if (notification !== undefined && notification.kind === undefined) {
        latestLegacyId = notification.id;
        break;
      }
    }
    for (const notification of pending) {
      const judgmentNeeded =
        notification.kind === "coordinator" ||
        (notification.kind === undefined &&
          taskNeedsCoordinatorJudgment(task) &&
          notification.id === latestLegacyId);
      result.push({
        taskId: task.id,
        notificationId: notification.id,
        message: notification.message,
        judgmentNeeded,
      });
    }
  }
  return result;
}

type NotificationMessageSink = Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
type NotificationUi = Readonly<{ readonly ui: Pick<ExtensionContext["ui"], "notify"> }>;

function notificationContent(notifications: readonly NotificationRef[]): string {
  return notifications
    .map(
      (notification) =>
        `[${notification.taskId}] ${compactText(notification.message, ACTION_SUMMARY_MAX_TEXT)}`,
    )
    .join("\n");
}

/** Deliver pending notifications without turning routine scheduler work into model input. */
export async function deliverPendingNotifications(
  pi: NotificationMessageSink,
  service: Pick<TandemService, "acknowledge">,
  tasks: readonly TaskRecord[],
  delivered: Set<string>,
  ctx: NotificationUi,
): Promise<void> {
  const pending = allPendingNotifications(tasks).filter(
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

export async function listAndDeliverPendingNotifications(
  pi: NotificationMessageSink,
  service: Pick<TandemService, "list" | "acknowledge">,
  delivered: Set<string>,
  ctx: NotificationUi,
): Promise<void> {
  await deliverPendingNotifications(pi, service, await service.list(), delivered, ctx);
}
