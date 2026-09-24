import { realpath } from "node:fs/promises";
import type { Clock, IdFactory, RequestBriefRecord, TaskRecord } from "../contracts.ts";
import type { RequestBriefStore } from "../requests/store.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import type { DurableJob, RuntimeState } from "../runtime/schema.ts";
import type { RequestUsageEvent } from "../runtime/usage.ts";
import {
  type JobTokenTally,
  requestIntakeEvent,
  requestTerminalEvent,
  settledWorkEvents,
} from "../runtime/usage-events.ts";
import { type RequestUsageLedger, readCoordinatorUsage } from "../runtime/usage-ledger.ts";
import { coordinatorShare, type RequestUsageReceipt } from "../runtime/usage-receipt.ts";
import { readWorkerTokenTally } from "../workers/terminal.ts";
import { errorClassName, singleLine } from "./records.ts";

export type RequestAccountingDependencies = Readonly<{
  readonly home: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly requestStore: RequestBriefStore;
  readonly usage: RequestUsageLedger;
  /** The coordinator's repository; receipts and brief listings are scoped to it when known. */
  readonly sourceRepoPath: string | undefined;
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  readonly openRequestForNewWork: (
    repoPath: string,
    tasks: readonly TaskRecord[],
  ) => Promise<string | undefined>;
  readonly readState: () => Promise<RuntimeState>;
  readonly updateTask: (
    taskId: string,
    transform: (task: TaskRecord) => TaskRecord,
  ) => Promise<TaskRecord>;
}>;

/**
 * Keeps the request usage ledger level with durable task state and reads receipts back out.
 * Accounting observes work; it never authorizes, pauses, retries, or blocks it.
 */
export class RequestAccountingWorkflow {
  readonly #deps: RequestAccountingDependencies;

  constructor(deps: RequestAccountingDependencies) {
    this.#deps = deps;
  }

  /** A ledger failure is reported and the caller carries on unchanged. */
  async record(events: readonly RequestUsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    let added: readonly RequestUsageEvent[];
    try {
      added = (await this.#deps.usage.record(events)).added;
    } catch (error) {
      await this.diagnoseFailure(error, events.length);
      return;
    }
    for (const event of added) {
      if (event.kind === "terminal" && event.outcome === "delivered") {
        await this.notifyReceiptReady(event);
      }
    }
  }

  /**
   * Brings the ledger level with durable state: the intake of every governing request, one span
   * per settled operation, and the terminal fact of every delivered or cancelled task. Each event
   * identity is derived from the records themselves, so repeating this pass after a restart, a
   * reconciliation, or a compaction records nothing new.
   */
  async recordSettledTasks(tasks: readonly TaskRecord[]): Promise<void> {
    const governed = tasks.filter((task) => task.requestId !== undefined);
    if (governed.length === 0) return;
    const state = await this.#deps.readState();
    try {
      await this.record(await this.settledTaskEvents(governed, state));
    } catch (error) {
      await this.diagnoseFailure(error);
    }
  }

  /**
   * Pins the request's delivery, cancellation, or failure moment at the transition that caused it,
   * so a later cleanup or reconciliation pass that touches the task cannot move the recorded time.
   */
  async recordTerminalTransition(task: TaskRecord): Promise<void> {
    const requestId = task.requestId;
    if (requestId === undefined) return;
    const terminal = requestTerminalEvent(requestId, task);
    if (terminal !== undefined) await this.record([terminal]);
  }

  /**
   * The request's receipt, with its goal and the coordinator's shared usage over the request's
   * window. An open request is measured up to now, so it can be checked partway through. Without
   * an id, the receipt is for the request in progress.
   */
  async receipt(requestId?: string): Promise<RequestUsageReceipt> {
    const id = requestId ?? (await this.requestInProgress());
    const receipt = await this.#deps.usage.receipt(id);
    const brief = await this.#deps.requestStore.read(id);
    const from = receipt.timing.intakeAt;
    if (brief === undefined || from === "unavailable") return receipt;
    const open = receipt.timing.terminalAt === "unavailable";
    const to = open ? this.#deps.clock() : receipt.timing.terminalAt;
    const repoPath = await canonicalPath(brief.repoPath);
    return {
      ...receipt,
      goal: brief.draft.content.goal,
      ...(open ? { asOf: to } : {}),
      coordinator: coordinatorShare(
        await readCoordinatorUsage(this.#deps.home),
        repoPath,
        from,
        to,
      ),
    };
  }

  /** Briefs for the coordinator's repository (all of them without one), newest first. */
  async briefs(): Promise<readonly RequestBriefRecord[]> {
    const repoPath = this.#deps.sourceRepoPath;
    const here = repoPath === undefined ? undefined : await canonicalPath(repoPath);
    const records = [];
    for (const record of await this.#deps.requestStore.list()) {
      if (here === undefined || (await canonicalPath(record.repoPath)) === here) {
        records.push(record);
      }
    }
    return records.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async settledTaskEvents(
    tasks: readonly TaskRecord[],
    state: RuntimeState,
  ): Promise<readonly RequestUsageEvent[]> {
    const events: RequestUsageEvent[] = [];
    const openedRequests = new Set<string>();
    for (const task of tasks) {
      const requestId = task.requestId;
      if (requestId === undefined) continue;
      if (!openedRequests.has(requestId)) {
        openedRequests.add(requestId);
        const brief = await this.#deps.requestStore.read(requestId);
        if (brief !== undefined) events.push(requestIntakeEvent(brief));
      }
      // Research usually runs before its brief exists, so it is credited to the request through
      // the implementation that cites it rather than by joining the request's membership.
      const researchTaskIds = (task.researchHandoffs ?? []).map((handoff) => handoff.scoutTaskId);
      for (const taskId of [task.id, ...researchTaskIds]) {
        events.push(...(await settledWorkEventsFor(requestId, taskId, state)));
      }
      const terminal = requestTerminalEvent(requestId, task);
      if (terminal !== undefined) events.push(terminal);
    }
    return events;
  }

  /**
   * The request a person means by "this request": the one open approved request in the
   * coordinator's repository, or else the one whose brief changed most recently.
   */
  private async requestInProgress(): Promise<string> {
    const repoPath = this.#deps.sourceRepoPath;
    if (repoPath !== undefined) {
      const open = await this.#deps.openRequestForNewWork(
        await canonicalPath(repoPath),
        await this.#deps.listTasks(),
      );
      if (open !== undefined) return open;
    }
    const latest = (await this.briefs())[0];
    if (latest === undefined) throw new Error("There is no request to show a receipt for yet");
    return latest.id;
  }

  /**
   * Wakes the coordinator once, when a request's delivery is first recorded, to show the person
   * where the request's time and tokens went. The ledger records each delivery once, so a replay
   * never repeats this.
   */
  private async notifyReceiptReady(event: RequestUsageEvent): Promise<void> {
    const taskId = event.identity.taskId;
    if (taskId === undefined) return;
    await this.#deps.updateTask(taskId, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      notifications: [
        ...current.notifications,
        {
          id: singleLine(this.#deps.idFactory(), "receipt notification id"),
          message:
            "The request is delivered. Show where its time and tokens went: call request-receipt for this task's request and show its table exactly as returned.",
          acknowledged: false,
          kind: "coordinator",
        },
      ],
    }));
  }

  private async diagnoseFailure(error: unknown, events?: number): Promise<void> {
    try {
      await appendDiagnosticEvent(
        this.#deps.home,
        {
          event: "request-accounting-failed",
          details: {
            errorClass: errorClassName(error),
            ...(events === undefined ? {} : { events }),
          },
        },
        this.#deps.clock,
      );
    } catch {
      // Observability must not make request accounting fail either.
    }
  }
}

function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function settledWorkEventsFor(
  requestId: string,
  taskId: string,
  state: RuntimeState,
): Promise<readonly RequestUsageEvent[]> {
  const runtime = state.tasks.find((entry) => entry.taskId === taskId);
  if (runtime === undefined) return [];
  const presentations = state.presentations.filter(
    (presentation) => presentation.taskId === taskId,
  );
  return settledWorkEvents({
    requestId,
    runtime,
    presentations,
    tallies: await jobTokenTallies([
      ...runtime.jobs,
      ...presentations.flatMap((presentation) =>
        presentation.job === undefined ? [] : [presentation.job],
      ),
    ]),
  });
}

/** The token tallies the given jobs' workers recorded, keyed by job id. */
async function jobTokenTallies(
  jobs: readonly DurableJob[],
): Promise<ReadonlyMap<string, JobTokenTally>> {
  const tallies = new Map<string, JobTokenTally>();
  for (const job of jobs) {
    const tally = await readWorkerTokenTally(job.jobPath);
    if (tally === undefined) continue;
    tallies.set(job.id, {
      inputTokens: tally.inputTokens + tally.cacheReadTokens + tally.cacheWriteTokens,
      outputTokens: tally.outputTokens,
      costUsd: tally.costUsd,
    });
  }
  return tallies;
}
