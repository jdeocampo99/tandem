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
import { admissionWaitToRecord, type TimelineNote } from "../tasks/timeline.ts";
import { latestAdmissionWait, poolAdmissionWaitReason } from "../workers/admission.ts";

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

/** The task write a pool check amounts to, and the timeline note that goes with it. */
export type PoolAdmissionChange = Readonly<{
  /** The same record when nothing changes. */
  readonly task: TaskRecord;
  readonly note?: TimelineNote;
}>;

/**
 * The task record after a pool check. A queued task is notified once per new blocking reason, and
 * its timeline records the wait whenever the reason differs from the latest one its runtime record
 * noted; without a runtime record nothing remembers the reason, so no wait is recorded. An allowed
 * allocation withdraws earlier pool notices.
 */
export function taskWithPoolAdmission(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
  result: PoolMaintenanceResult,
  stamp: Readonly<{ readonly clock: Clock; readonly notificationId: () => string }>,
): PoolAdmissionChange {
  const key = poolAdmissionKey(result);
  if (key === undefined) {
    const notifications = task.notifications.filter((entry) => !isPoolNotification(entry));
    if (notifications.length === task.notifications.length) return { task };
    return {
      task: { ...task, revision: task.revision + 1, updatedAt: stamp.clock(), notifications },
    };
  }
  const notice = poolAdmissionNotice(result);
  const notify =
    task.stage === "queued" &&
    runtime?.poolAdmissionKey !== key &&
    !task.notifications.some((entry) => isPoolNotificationForKey(entry, key));
  const wait =
    runtime === undefined
      ? undefined
      : admissionWaitToRecord(
          task.stage,
          latestAdmissionWait(runtime),
          poolAdmissionWaitReason(key),
        );
  if (!notify && wait === undefined) return { task };
  return {
    task: {
      ...task,
      revision: task.revision + 1,
      updatedAt: stamp.clock(),
      notifications: notify
        ? [
            ...task.notifications,
            {
              id: stamp.notificationId(),
              message: poolNotificationMessage(key, notice),
              acknowledged: false,
            },
          ]
        : task.notifications,
    },
    ...(wait === undefined ? {} : { note: { admissionWait: wait, cause: notice } }),
  };
}
