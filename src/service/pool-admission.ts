import type { Clock, TaskRecord } from "../contracts.ts";
import {
  isPoolNotification,
  isPoolNotificationForKey,
  type PoolMaintenanceResult,
  poolAdmissionKey,
  poolAdmissionNotice,
  poolNotificationMessage,
} from "../pool/policy.ts";
import type { RuntimeTaskState } from "../runtime/schema.ts";

/**
 * The runtime record after a pool check: a blocked allocation is recorded as the task's pool
 * notice and last error; an allowed one clears both, keeping an unrelated last error.
 */
export function runtimeWithPoolAdmission(
  current: RuntimeTaskState,
  result: PoolMaintenanceResult,
): RuntimeTaskState {
  const key = poolAdmissionKey(result);
  if (key === undefined) {
    const {
      poolAdmissionKey: _poolAdmissionKey,
      poolNotice: _poolNotice,
      ...withoutPoolNotice
    } = current;
    if (current.lastError === current.poolNotice) {
      const { lastError: _lastError, ...withoutError } = withoutPoolNotice;
      return withoutError;
    }
    return withoutPoolNotice;
  }
  const notice = poolAdmissionNotice(result);
  return { ...current, poolAdmissionKey: key, poolNotice: notice, lastError: notice };
}

/**
 * The task record after a pool check, or the same record when nothing changes. A queued task is
 * notified once per new blocking reason; an allowed allocation withdraws earlier pool notices.
 */
export function taskWithPoolAdmission(
  task: TaskRecord,
  previousKey: RuntimeTaskState["poolAdmissionKey"],
  result: PoolMaintenanceResult,
  stamp: Readonly<{ readonly clock: Clock; readonly notificationId: () => string }>,
): TaskRecord {
  const key = poolAdmissionKey(result);
  if (key === undefined) {
    const notifications = task.notifications.filter((entry) => !isPoolNotification(entry));
    if (notifications.length === task.notifications.length) return task;
    return { ...task, revision: task.revision + 1, updatedAt: stamp.clock(), notifications };
  }
  const notify =
    task.stage === "queued" &&
    previousKey !== key &&
    !task.notifications.some((entry) => isPoolNotificationForKey(entry, key));
  if (!notify) return task;
  return {
    ...task,
    revision: task.revision + 1,
    updatedAt: stamp.clock(),
    notifications: [
      ...task.notifications,
      {
        id: stamp.notificationId(),
        message: poolNotificationMessage(key, poolAdmissionNotice(result)),
        acknowledged: false,
      },
    ],
  };
}
