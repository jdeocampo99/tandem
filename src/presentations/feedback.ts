import { openPresentation } from "../adapters/lavish.ts";
import type {
  Clock,
  CommandRunner,
  IdFactory,
  NotificationKind,
  TaskRecord,
} from "../contracts.ts";
import { presentationRuntime } from "../runtime/activity.ts";
import { readRuntimeState, writeJsonAtomically } from "../runtime/persistence.ts";
import type { RuntimePresentation, RuntimeState } from "../runtime/schema.ts";
import { describeError, singleLine } from "../service/records.ts";
import type { TaskStore } from "../tasks/store.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import { writePresentationFeedbackEvidence } from "./evidence.ts";
import {
  PRESENTATION_LOCK_POLL_MS,
  PRESENTATION_LOCK_TIMEOUT_MS,
  presentationFeedbackLockPath,
  withPresentationLock,
} from "./lock.ts";
import {
  clearRecordError,
  hasPendingPresentationNotification,
  observationError,
  type PendingPresentationNotification,
  type PresentationRecord,
  presentationNotificationForTransition,
  presentationPendingNotifications,
  readPresentationRecord,
  samePresentationRecord,
  statusForObservation,
} from "./records.ts";
import { readPresentationFeedback, writeRevisionBrief } from "./session.ts";

export type PresentationFeedbackDependencies = Readonly<{
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly readTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
}>;

const MANUAL_SHARED_FEEDBACK_WAIT_MS = 1_000;
const MAX_EXCERPT_CHARS = 300;

function excerpt(text: string): string {
  const line = text.trim().replace(/\s+/gu, " ");
  return line.length <= MAX_EXCERPT_CHARS ? line : `${line.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

/** The listener's observation laid over the record as it is now, not as it was when polling began. */
function withObservation(
  current: PresentationRecord,
  observed: PresentationRecord,
): PresentationRecord {
  const base = clearRecordError(current);
  return {
    ...base,
    status: observed.status,
    updatedAt: observed.updatedAt,
    ...(observed.sessionUrl === undefined ? {} : { sessionUrl: observed.sessionUrl }),
    ...(observed.observation === undefined ? {} : { observation: observed.observation }),
    ...(observed.error === undefined ? {} : { error: observed.error }),
  };
}

type PresentationPollState = Readonly<{
  readonly promise: Promise<PresentationRecord>;
  readonly controller: AbortController;
}>;

function waitForPresentationFeedback(
  pending: Promise<PresentationRecord>,
  readCurrent: () => Promise<PresentationRecord>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<PresentationRecord> {
  const { promise, resolve, reject } = Promise.withResolvers<PresentationRecord>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    clearTimeout(timeout);
  };
  const finish = (action: () => void): void => {
    cleanup();
    action();
  };
  const resolveCurrent = (): void => {
    void readCurrent().then(resolve, reject);
  };
  const onAbort = (): void => finish(resolveCurrent);
  if (signal?.aborted) {
    resolveCurrent();
    return promise;
  }
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) timeout = setTimeout(() => finish(resolveCurrent), timeoutMs);
  void pending.then(
    (updated) => finish(() => resolve(updated)),
    (error: unknown) => finish(() => reject(error)),
  );
  return promise;
}

export class PresentationFeedbackWorkflow {
  readonly #deps: PresentationFeedbackDependencies;
  readonly #polls = new Map<string, PresentationPollState>();
  #shuttingDown = false;

  constructor(deps: PresentationFeedbackDependencies) {
    this.#deps = deps;
  }

  withPresentationNotification(
    previous: PresentationRecord,
    next: PresentationRecord,
    options: Readonly<{
      readonly notificationId?: string;
      readonly feedbackEvidencePath?: string;
    }> = {},
  ): PresentationRecord {
    const details = presentationNotificationForTransition(
      previous,
      next,
      options.feedbackEvidencePath,
    );
    if (details === undefined) return next;
    const pending: PendingPresentationNotification = {
      id: singleLine(
        options.notificationId ?? this.#deps.idFactory(),
        "presentation notification id",
      ),
      ...details,
    };
    if (next.pendingNotification !== undefined) {
      return {
        ...next,
        pendingNotificationQueue: [...(next.pendingNotificationQueue ?? []), pending],
      };
    }
    if ((next.pendingNotificationQueue?.length ?? 0) > 0) {
      return {
        ...next,
        pendingNotificationQueue: [...(next.pendingNotificationQueue ?? []), pending],
      };
    }
    return { ...next, pendingNotification: pending };
  }

  /** Queues one notification with this exact message, after any already pending. */
  withRevisionNotification(
    record: PresentationRecord,
    message: string,
    kind: NotificationKind,
  ): PresentationRecord {
    const pending: PendingPresentationNotification = {
      id: singleLine(this.#deps.idFactory(), "presentation notification id"),
      message,
      kind,
    };
    return hasPendingPresentationNotification(record)
      ? {
          ...record,
          pendingNotificationQueue: [...(record.pendingNotificationQueue ?? []), pending],
        }
      : { ...record, pendingNotification: pending };
  }

  /**
   * Sends a Lavish comment to the agent that drew the page as its next request, or holds it until
   * the agent finishes the one it is on.
   */
  async requestRevision(record: PresentationRecord, feedback: string): Promise<PresentationRecord> {
    if (record.request !== undefined) {
      return this.withRevisionNotification(
        { ...record, pendingFeedback: [...(record.pendingFeedback ?? []), feedback] },
        `Queued a Lavish comment for presentation ${record.id} until the research agent finishes its current change: ${excerpt(feedback)}`,
        "routine",
      );
    }
    const id = singleLine(this.#deps.idFactory(), "presentation request id");
    const briefPath = await writeRevisionBrief(record, id, feedback);
    return this.withRevisionNotification(
      {
        ...record,
        request: { id, kind: "revise", briefPath, requestedAt: this.#deps.clock() },
      },
      `The research agent is revising presentation ${record.id} from a Lavish comment: ${excerpt(feedback)}`,
      "routine",
    );
  }

  /** Turns comments held during the last request into the next one. */
  async nextQueuedRevision(record: PresentationRecord): Promise<PresentationRecord> {
    const { pendingFeedback, ...rest } = record;
    if (pendingFeedback === undefined || pendingFeedback.length === 0) return record;
    if (record.agent === undefined || record.status === "failed") return rest;
    return this.requestRevision(rest, pendingFeedback.join("\n\n"));
  }

  async flushPresentationNotification(
    runtime: Pick<RuntimePresentation, "recordPath">,
    signal?: AbortSignal,
  ): Promise<PresentationRecord> {
    while (true) {
      let record: PresentationRecord;
      try {
        record = await withPresentationLock(runtime.recordPath, signal, () =>
          this.#deps.store.exclusive(async (store) => {
            const current = await readPresentationRecord(runtime.recordPath);
            const pending = presentationPendingNotifications(current)[0];
            if (pending === undefined) return current;
            const task = await store.read(current.taskId);
            if (task === undefined || !(await this.#deps.taskInScope(task))) {
              throw new Error(`task ${current.taskId} is missing`);
            }
            const existing = task.notifications.find((entry) => entry.id === pending.id);
            if (existing === undefined) {
              await store.update(current.taskId, task.revision, (updated) => ({
                ...updated,
                revision: updated.revision + 1,
                updatedAt: this.#deps.clock(),
                notifications: [
                  ...updated.notifications,
                  {
                    id: pending.id,
                    message: pending.message,
                    acknowledged: false,
                    kind: pending.kind,
                  },
                ],
              }));
            } else if (existing.message !== pending.message || existing.kind !== pending.kind) {
              throw new Error(
                `presentation notification ${pending.id} conflicts with task history`,
              );
            }
            const remaining = presentationPendingNotifications(current).slice(1);
            const {
              pendingNotification: _pending,
              pendingNotificationQueue: _queue,
              ...withoutPending
            } = current;
            const [nextPending, ...queued] = remaining;
            const cleared =
              nextPending === undefined
                ? withoutPending
                : {
                    ...withoutPending,
                    pendingNotification: nextPending,
                    ...(queued.length === 0 ? {} : { pendingNotificationQueue: queued }),
                  };
            await writeJsonAtomically(runtime.recordPath, cleared);
            return cleared;
          }),
        );
      } catch (error) {
        if (error instanceof StoreLockTimeoutError || signal?.aborted) {
          return readPresentationRecord(runtime.recordPath);
        }
        throw error;
      }
      if (!hasPendingPresentationNotification(record) || signal?.aborted) return record;
    }
  }

  private async pollPresentationFeedback(
    runtime: Pick<RuntimePresentation, "recordPath">,
    expected: PresentationRecord,
    signal: AbortSignal,
    continuous: boolean,
    allowBrowserDisconnected: boolean,
  ): Promise<PresentationRecord> {
    const before = await this.flushPresentationNotification(runtime, signal);
    if (hasPendingPresentationNotification(before) || this.#shuttingDown || signal.aborted)
      return before;
    let release: () => Promise<void>;
    try {
      release = await acquireDarwinFileLock(
        presentationFeedbackLockPath(runtime.recordPath),
        PRESENTATION_LOCK_TIMEOUT_MS,
        PRESENTATION_LOCK_POLL_MS,
        signal,
      );
    } catch (error) {
      if (error instanceof StoreLockTimeoutError || signal.aborted) {
        return readPresentationRecord(runtime.recordPath);
      }
      throw error;
    }
    try {
      const previous = await readPresentationRecord(runtime.recordPath);
      const canPoll =
        !this.#shuttingDown &&
        !signal.aborted &&
        samePresentationRecord(expected, previous) &&
        !hasPendingPresentationNotification(previous) &&
        previous.status === "open" &&
        (allowBrowserDisconnected || previous.observation?.status !== "browser_disconnected");
      if (canPoll) {
        const observed = await readPresentationFeedback({
          record: previous,
          clock: this.#deps.clock,
          run: this.#deps.run,
          signal,
          continuous,
        });
        if (observed !== previous) await this.recordObservation(runtime, previous, observed);
      }
    } finally {
      await release();
    }
    return this.flushPresentationNotification(runtime, signal);
  }
  /**
   * Stores what the listener saw. A comment on a page the research agent drew becomes its next
   * request; any other observation notifies the coordinator as before.
   */
  private async recordObservation(
    runtime: Pick<RuntimePresentation, "recordPath">,
    previous: PresentationRecord,
    observed: PresentationRecord,
  ): Promise<void> {
    await withPresentationLock(runtime.recordPath, undefined, async () => {
      const current = await readPresentationRecord(runtime.recordPath);
      // A failure or end recorded while the listener waited wins over what it saw.
      if (!samePresentationRecord(previous, current) && current.status !== "open") return;
      const next = withObservation(current, observed);
      const observation = observed.observation;
      if (observation?.status !== "feedback") {
        await writeJsonAtomically(
          runtime.recordPath,
          this.withPresentationNotification(current, next),
        );
        return;
      }
      const notificationId = singleLine(this.#deps.idFactory(), "presentation notification id");
      const feedbackEvidencePath = await writePresentationFeedbackEvidence({
        record: current,
        eventId: notificationId,
        observedAt: observed.updatedAt,
        observation,
      });
      const updated =
        current.agent !== undefined && observation.rawFeedback.trim().length > 0
          ? await this.requestRevision(next, observation.rawFeedback)
          : this.withPresentationNotification(current, next, {
              notificationId,
              feedbackEvidencePath,
            });
      await writeJsonAtomically(runtime.recordPath, updated);
    });
  }

  private beginPresentationFeedback(
    runtime: RuntimePresentation,
    record: PresentationRecord,
    signal?: AbortSignal,
    continuous = false,
    allowBrowserDisconnected = false,
  ): Promise<PresentationRecord> {
    const existing = this.#polls.get(runtime.id);
    if (existing !== undefined) {
      return continuous
        ? existing.promise
        : waitForPresentationFeedback(
            existing.promise,
            () => readPresentationRecord(runtime.recordPath),
            signal,
            MANUAL_SHARED_FEEDBACK_WAIT_MS,
          );
    }
    if (this.#shuttingDown) return Promise.resolve(record);
    const controller = new AbortController();
    const onAbort = signal === undefined ? undefined : (): void => controller.abort(signal.reason);
    if (signal !== undefined && onAbort !== undefined) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const poll = this.pollPresentationFeedback(
      runtime,
      record,
      controller.signal,
      continuous,
      allowBrowserDisconnected,
    )
      .catch(async (error) => {
        if (!continuous) throw error;
        if (!this.#shuttingDown) await this.projectFeedbackFailure(runtime, error);
        return readPresentationRecord(runtime.recordPath);
      })
      .finally(() => {
        if (this.#polls.get(runtime.id)?.promise === poll) {
          this.#polls.delete(runtime.id);
        }
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      });
    this.#polls.set(runtime.id, { promise: poll, controller });
    void poll.catch(() => undefined);
    return poll;
  }
  private async projectFeedbackFailure(
    runtime: RuntimePresentation,
    error: unknown,
  ): Promise<void> {
    if (error instanceof Error && error.name === "AbortError") return;
    const reason = `presentation feedback poll failed: ${describeError(error)}`;
    let shouldFlush = false;
    await withPresentationLock(runtime.recordPath, undefined, async () => {
      const state = await this.readState();
      if (presentationRuntime(state, runtime.id) === undefined) return;
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status === "ended" || record.status === "failed") return;
      const failed: PresentationRecord = {
        ...record,
        status: "failed",
        error: reason,
        updatedAt: this.#deps.clock(),
      };
      const failedWithNotification = this.withPresentationNotification(record, failed);
      await writeJsonAtomically(runtime.recordPath, failedWithNotification);
      shouldFlush = hasPendingPresentationNotification(failedWithNotification);
    });
    if (shouldFlush) await this.flushPresentationNotification(runtime);
  }

  startPresentationFeedback(runtime: RuntimePresentation, record: PresentationRecord): void {
    if (this.#shuttingDown) return;
    if (
      !hasPendingPresentationNotification(record) &&
      (record.status !== "open" || record.observation?.status === "browser_disconnected")
    )
      return;
    void this.beginPresentationFeedback(runtime, record, undefined, true, false).catch(
      () => undefined,
    );
  }

  async feedback(presentationId: string, signal?: AbortSignal): Promise<PresentationRecord> {
    const id = singleLine(presentationId, "presentationId");
    const state = await this.readState();
    const runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`Presentation ${id} was not found`);
    await this.#deps.readTask(runtime.taskId);
    const record = await readPresentationRecord(runtime.recordPath);
    return this.beginPresentationFeedback(runtime, record, signal, false, true);
  }

  /**
   * Brings a presentation back up because the user asked to see it, including one they ended in
   * the browser. While its listener runs this only resumes the browser view; otherwise it records
   * the new session and starts listening again.
   */
  async open(presentationId: string): Promise<PresentationRecord> {
    const id = singleLine(presentationId, "presentationId");
    const runtime = presentationRuntime(await this.readState(), id);
    if (runtime === undefined) throw new Error(`Presentation ${id} was not found`);
    await this.#deps.readTask(runtime.taskId);
    const record = await readPresentationRecord(runtime.recordPath);
    // A failed record that was never opened has no verified artifact to show.
    const shown = record.status === "open" || record.status === "ended";
    if (!shown && !(record.status === "failed" && record.observation !== undefined)) {
      throw new Error(`Presentation ${id} is ${record.status}, so there is nothing to open yet`);
    }
    if (this.#polls.has(id)) {
      await openPresentation(this.#deps.run, record.artifactPath, record.cwd);
      return record;
    }
    const opened = await withPresentationLock(runtime.recordPath, undefined, async () => {
      const current = await readPresentationRecord(runtime.recordPath);
      const observation = await openPresentation(
        this.#deps.run,
        current.artifactPath,
        current.cwd,
        { reopen: true },
      );
      const failure = observationError(observation);
      const sessionUrl = observation.sessionUrl ?? current.sessionUrl;
      const next: PresentationRecord = {
        ...clearRecordError(current),
        status: statusForObservation(observation),
        updatedAt: this.#deps.clock(),
        ...(sessionUrl === undefined ? {} : { sessionUrl }),
        observation,
        ...(failure === undefined ? {} : { error: failure }),
      };
      await writeJsonAtomically(runtime.recordPath, next);
      // Re-read so the listener's same-record check compares the parsed shape it will see.
      return readPresentationRecord(runtime.recordPath);
    });
    this.startPresentationFeedback(runtime, opened);
    return opened;
  }

  private async readState(): Promise<RuntimeState> {
    return this.#deps.store.exclusive(() => readRuntimeState(this.#deps.runtimePath));
  }

  shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const polls = [...this.#polls.values()];
    for (const poll of polls) poll.controller.abort(new Error("Tandem service is shutting down"));
    return Promise.allSettled(polls.map((poll) => poll.promise)).then(() => undefined);
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }
}
