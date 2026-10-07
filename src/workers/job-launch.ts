import { mkdir, readFile } from "node:fs/promises";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  TaskRecord,
} from "../contracts.ts";
import { harnessOf } from "../harness/contract.ts";
import { PLAYBOOKS, type PlaybookId } from "../playbooks/catalog.ts";
import { playbookForRun } from "../playbooks/selection.ts";
import { buildPrReviewBrief } from "../pr-review/brief.ts";
import { readRunFiles } from "../pr-review/run.ts";
import { prReviewRunDiffPath } from "../pr-review/state.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import {
  readRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type { DurableJob, DurableOperationPhase, RuntimeTaskState } from "../runtime/schema.ts";
import {
  buildPrompt,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  isRecord,
  jobDirectoryFor,
  jobPaths,
  makeDurableJob,
  modelRoleForTask,
  replaceJob,
  replaceRuntimeTask,
  reportPathFor,
  singleLine,
  workerCommand,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import { policyIdentity } from "../tasks/acceptance.ts";
import { taskInboxPath, workerReceiptPath } from "../tasks/communication-persistence.ts";
import { quickScopeQuestionAllowed } from "../tasks/quick.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { resolvedExecutionModel } from "./execution-routing.ts";
import { taskAtRest } from "./job-settlement.ts";
import { parseWorkerJob, type WorkerJob, type WorkerRole } from "./jobs.ts";
import {
  claimOf,
  executionIdentity,
  holdsClaim,
  type OperationClaim,
  operationSettled,
} from "./operation-claim.ts";
import type { OperationRecords } from "./operation-records.ts";
import { workerBriefContext } from "./prompts.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "./terminal-control.ts";
import { validationCommandLine } from "./validation-commands.ts";

/** Re-stamps a prepared job spec with the claim now launching it, after checking its identity. */
async function refreshJobSpecClaim(job: DurableJob, claim: OperationClaim): Promise<void> {
  const parsed = JSON.parse(await readFile(job.jobPath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.id !== job.id || parsed.taskId !== job.taskId) {
    throw new Error("prepared job spec identity does not match durable job");
  }
  if (parsed.generation !== job.generation || !isRecord(parsed.execution)) {
    throw new Error("prepared job spec execution identity is invalid");
  }
  await writeJsonAtomically(job.jobPath, {
    ...parsed,
    execution: {
      ...parsed.execution,
      operationId: claim.id,
      fencingRevision: claim.fencingRevision,
      claimOwner: claim.claimOwner,
    },
  });
}

/** The job spec a scout, implementer, or PR review worker runs from. */
function workerJobSpec(
  input: Readonly<{
    readonly home: string;
    readonly task: TaskRecord;
    readonly runtime: RuntimeTaskState;
    readonly role: WorkerRole;
    readonly jobId: string;
    readonly prompt: string;
    readonly resultPath: string;
    readonly communication: NonNullable<WorkerJob["communication"]>;
    readonly sessionDirectory: string | undefined;
    readonly timeoutMs: number | undefined;
    readonly playbook: PlaybookId | undefined;
  }>,
): WorkerJob {
  const { home, task, runtime, role, sessionDirectory, timeoutMs } = input;
  const prReview = task.prReview;
  const model = resolvedExecutionModel(
    runtime.operation?.routing,
    task.policy.config.models[modelRoleForTask(task, role)],
  );
  return {
    schemaVersion: 1,
    id: input.jobId,
    taskId: task.id,
    generation: task.generation,
    role,
    cwd: runtime.worktree?.path ?? taskSourcePath(task, runtime),
    harness: harnessOf(model),
    model,
    prompt: input.prompt,
    resultPath: input.resultPath,
    ...(runtime.operation === undefined
      ? {}
      : { execution: executionIdentity(home, runtime.operation) }),
    communication: input.communication,
    // One OMP conversation per task: a fix round continues where the implementer left off.
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(role === "implementer" && task.policy.config.setupCommands.length > 0
      ? { setup: task.policy.config.setupCommands }
      : {}),
    ...(input.playbook === undefined ? {} : { playbookSteps: PLAYBOOKS[input.playbook].steps }),
    ...(role === "implementer" && task.policy.config.validationCommands.length > 0
      ? { validationCommands: task.policy.config.validationCommands.map(validationCommandLine) }
      : {}),
    ...(role === "implementer" && task.quick !== undefined
      ? { quickScope: quickScopeQuestionAllowed(task) ? ("may-ask" as const) : ("spent" as const) }
      : {}),
    ...(prReview === undefined
      ? {}
      : {
          prReview: {
            structuredReport: prReview.mode !== "question",
            diffPath: prReviewRunDiffPath(home, task.id, task.generation),
            inlineComments: prReview.lens.kind !== "intent",
          },
        }),
  };
}

export type JobLauncherDependencies = Readonly<{
  readonly home: string;
  /** The owner this coordinator stamps on every operation it admits or takes over. */
  readonly claimOwner: string;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly workerPath: string;
  readonly workerTimeoutMs: number | undefined;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly resultExists: (path: string) => Promise<boolean>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
  readonly records: OperationRecords;
}>;

/**
 * Starts a reserved job in its pane: records the launch intent, types the worker command, and
 * proves the worker came up, quarantining any launch whose outcome it cannot prove.
 */
export class JobLauncher {
  readonly #deps: JobLauncherDependencies;

  constructor(deps: JobLauncherDependencies) {
    this.#deps = deps;
  }

  async launchAgent(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    endpoint: Endpoint,
    role: WorkerRole,
    options: Readonly<{
      /** Extra instructions prepended ahead of the usual context, e.g. central recovery's relaunch notice. */
      readonly extraInstructions?: readonly string[];
    }> = {},
  ): Promise<void> {
    const jobId = runtime.operation?.jobId ?? singleLine(this.#deps.idFactory(), "worker job id");
    const paths = jobPaths(jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId));
    const context = workerBriefContext(task, runtime, role, options.extraInstructions ?? []);
    const playbook =
      role === "implementer"
        ? playbookForRun(task.playbook, runtime.fixContextPath !== undefined)
        : undefined;
    const sessionDirectory =
      role === "implementer" || role === "scout" ? runtime.sessionDirectory : undefined;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) return;
    if (sessionDirectory !== undefined) {
      const prepared = await this.#deps.records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["scouting", "implementing"],
        async () => {
          await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
          return true;
        },
      );
      if (prepared !== true) return;
    }
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(paths.jobPath),
      initialRevision: instructionRevision,
    };
    const spec = workerJobSpec({
      home: this.#deps.home,
      task,
      runtime,
      role,
      jobId,
      prompt: await this.workerPrompt(task, role, paths.jobPath, context, playbook),
      resultPath: paths.resultPath,
      communication,
      sessionDirectory,
      timeoutMs: this.#deps.workerTimeoutMs,
      playbook,
    });
    const specWritten = await this.#deps.records.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["scouting", "implementing"],
      async () => {
        await writeJsonAtomically(paths.jobPath, spec);
        parseWorkerJob(spec);
        return true;
      },
    );
    if (specWritten !== true) return;
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      task.generation,
      role,
      "worker",
      spec.cwd,
      paths.jobPath,
      paths.resultPath,
      1,
      this.#deps.clock(),
      {
        ...(runtime.operation === undefined ? {} : { operationId: runtime.operation.id }),
        endpoint,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    try {
      await this.#deps.records.appendJob(task.id, durableJob, claim);
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (currentRuntime?.jobs.some(activeRuntimeJob)) return;
      throw error;
    }
    await this.launchJob(
      task.id,
      durableJob.id,
      endpoint,
      spec.cwd,
      workerCommand(this.#deps.workerPath, paths.jobPath),
      claim,
    );
  }

  /** The worker's prompt: the task brief, or for a PR review the brief built from its run files. */
  private async workerPrompt(
    task: TaskRecord,
    role: WorkerRole,
    jobPath: string,
    context: ReturnType<typeof workerBriefContext>,
    playbook: PlaybookId | undefined,
  ): Promise<string> {
    const prReview = task.prReview;
    if (prReview === undefined) {
      return buildPrompt(
        task,
        role,
        reportPathFor(jobPath),
        context.artifacts,
        undefined,
        context.instructions,
        playbook,
      );
    }
    const files = await readRunFiles(this.#deps.home, task.id, task.generation);
    return buildPrReviewBrief({
      state: prReview,
      head: files.head,
      from: files.from,
      contextPath: files.contextPath,
      diffPath: files.numberedDiffPath,
      extra: context.instructions,
    });
  }

  async launchJob(
    taskId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
    claim: OperationClaim,
  ): Promise<void> {
    return withStateLock(this.#deps.home, async () => {
      const launch = await this.recordLaunchIntent(taskId, jobId, claim);
      if (launch === undefined) return;
      try {
        await refreshJobSpecClaim(launch.job, claim);
      } catch (error) {
        await this.#deps.records.quarantineOperation(
          taskId,
          `prepared job spec could not be refreshed: ${describeError(error)}`,
          claim,
        );
        return;
      }
      let commandSent = false;
      try {
        const previousJob = workerJobForEndpoint(
          launch.runtime.jobs.filter((entry) => entry.id !== jobId),
          endpoint,
        );
        await prepareWorkerTerminal(this.#deps.terminal, {
          endpoint,
          cwd,
          ...(previousJob === undefined ? {} : { job: previousJob }),
        });
        commandSent = true;
        await this.#deps.terminal.inspect({ endpoint, cwd });
        await this.#deps.terminal.runCommand({ endpoint, cwd, command });
        await this.proveWorkerStartup(launch.job, endpoint, cwd);
      } catch (error) {
        if (!commandSent && error instanceof EndpointBusyError) {
          await this.deferBusyLaunch(taskId, jobId, claim, launch.runtime.operation?.phase, error);
          return;
        }
        const reason = `worker launch could not be proven after launch intent: ${describeError(error)}`;
        await this.quarantineUnprovenLaunch(taskId, jobId, claim, reason);
        return;
      }
      await this.recordLaunchRunning(taskId, jobId, claim, endpoint);
    });
  }

  /**
   * Marks the reserved job launching and records the worker effect's intent, before anything is
   * typed into a pane. A job whose operation no longer matches this claim, policy, or input HEAD
   * is left alone; one whose task stopped or rests is cancelled instead of launched.
   */
  private async recordLaunchIntent(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
  ): Promise<
    Readonly<{ readonly runtime: RuntimeTaskState; readonly job: DurableJob }> | undefined
  > {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      if (job.phase !== "reserved" || job.launchAttempted) return undefined;
      const operation = runtime.operation;
      if (
        operation?.jobId !== jobId ||
        operation.claimOwner !== this.#deps.claimOwner ||
        !holdsClaim(operation, claim) ||
        operation.policyDigest !== policyIdentity(task.policy) ||
        operationSettled(operation) ||
        operation.inputHead !==
          (operation.kind === "fix"
            ? operation.fixContext?.head
            : (task.reviewHead ?? runtime.sourceCheckpoint.head))
      ) {
        return undefined;
      }
      if (taskAtRest(task) || runtime.stopRequest !== undefined) {
        const cancelled = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: "worker launch was refused by a durable stop request",
          }));
          return {
            ...failed,
            ...(failed.operation === undefined
              ? {}
              : { operation: { ...failed.operation, phase: "cancelled" as const } }),
            ...(failed.reservation === undefined
              ? {}
              : {
                  reservation: {
                    ...failed.reservation,
                    phase: "released" as const,
                    releasedAt: this.#deps.clock(),
                  },
                }),
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, cancelled);
        return undefined;
      }
      const launching = replaceRuntimeTask(state, taskId, (current) => ({
        ...replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "launching",
          launchAttempted: true,
        })),
        ...(current.operation === undefined
          ? {}
          : {
              operation: {
                ...current.operation,
                phase: "launching" as const,
                effects: [
                  ...current.operation.effects,
                  {
                    id: jobId,
                    kind: "worker" as const,
                    phase: "intent" as const,
                    createdAt: this.#deps.clock(),
                    identity: job.jobPath,
                  },
                ],
              },
            }),
      }));
      await writeRuntimeState(this.#deps.runtimePath, launching);
      return { runtime, job };
    });
  }

  /** Quarantines a launch whose command may have been typed but whose worker was never proven. */
  private async quarantineUnprovenLaunch(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    reason: string,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        currentJob === undefined ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        currentJob.operationId !== operation.id ||
        current.stopRequest !== undefined
      ) {
        return;
      }
      const quarantined = replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        lastError: reason,
        operation: {
          ...operation,
          phase: "quarantined" as const,
          error: reason,
          effects: operation.effects.map((effect) =>
            effect.id === jobId ? { ...effect, phase: "unknown" as const } : effect,
          ),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, quarantined);
      await this.#deps.blockTask(taskId, reason, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "Tandem couldn't confirm the worker started.",
        detail: reason,
        jobId,
      });
    });
  }

  /** Records a proven launch: the job runs and the worker effect names the pane it runs in. */
  private async recordLaunchRunning(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    endpoint: Endpoint,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        currentJob === undefined ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        currentJob.operationId !== operation.id ||
        currentJob.phase !== "launching" ||
        current.stopRequest !== undefined ||
        operationSettled(operation)
      ) {
        return;
      }
      const running = replaceRuntimeTask(state, taskId, (entry) => ({
        ...replaceJob(entry, jobId, (candidate) => ({
          ...candidate,
          phase: "running",
          launchedAt: this.#deps.clock(),
        })),
        operation: {
          ...operation,
          phase: "running" as const,
          effects: operation.effects.map((effect) =>
            effect.id === jobId
              ? { ...effect, phase: "succeeded" as const, receipt: endpoint.paneId }
              : effect,
          ),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, running);
    });
  }

  // The busy pane refused before any command was typed, so the launch provably never
  // happened: undo the intent and let the next reconcile pass relaunch the reserved job.
  private async deferBusyLaunch(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    priorPhase: DurableOperationPhase | undefined,
    error: EndpointBusyError,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        priorPhase === undefined ||
        currentJob?.phase !== "launching" ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        operation.phase !== "launching"
      ) {
        return;
      }
      const deferred = replaceRuntimeTask(state, taskId, (entry) => ({
        ...replaceJob(entry, jobId, (candidate) => ({
          ...candidate,
          phase: "reserved",
          launchAttempted: false,
        })),
        lastError: `worker launch deferred: ${error.message}`,
        operation: {
          ...operation,
          phase: priorPhase,
          effects: operation.effects.filter((effect) => effect.id !== jobId),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, deferred);
    });
  }

  private async proveWorkerStartup(
    job: DurableJob,
    endpoint: Endpoint,
    cwd: string,
  ): Promise<void> {
    const deadline = Date.now() + DEFAULT_STARTUP_GRACE_MS;
    while (true) {
      const inspection = await this.#deps.terminal.inspect({ endpoint, cwd });
      if (inspection.activeWorker || (await this.#deps.resultExists(job.resultPath))) return;
      if (Date.now() >= deadline) {
        throw new Error(`worker did not become active within ${DEFAULT_STARTUP_GRACE_MS}ms`);
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
    }
  }
}
