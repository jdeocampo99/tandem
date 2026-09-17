import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../adapters/commands.ts";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, inspectEndpoint } from "../adapters/herdr.ts";
import type { OmpModelRecord } from "../adapters/omp.ts";
import { listOmpModels } from "../adapters/omp.ts";
import { releaseWorktree } from "../adapters/treehouse.ts";
import {
  type ModelSettings,
  parseModelAssignments,
  readModelSettings,
  writeModelSettings,
} from "../config/models.ts";
import { type OnboardRepoResult, onboardRepo, resolveRepoPolicy } from "../config/repositories.ts";
import type {
  AnswerTaskInput,
  Clock,
  CommandRunner,
  IdFactory,
  RepoPolicy,
  SteerTaskInput,
  TaskCommunicationView,
  TaskRecord,
} from "../contracts.ts";
import { describeTaskPr, type PrSummary } from "../delivery/evidence.ts";
import { mergeReviewedTask, publishReviewedTask } from "../delivery/pull-requests.ts";
import { maintainPool } from "../pool/maintenance.ts";
import {
  isPoolNotification,
  isPoolNotificationForKey,
  type PoolMaintenanceResult,
  poolAdmissionKey,
  poolAdmissionNotice,
  poolNotificationMessage,
} from "../pool/policy.ts";
import { PresentationFeedbackWorkflow } from "../presentations/feedback.ts";
import { type PresentationRecord, readPresentationRecord } from "../presentations/records.ts";
import { preparePresentation } from "../presentations/session.ts";
import { PresentationRuntimeWorkflow } from "../presentations/workflow.ts";
import {
  activeReservations,
  activeRuntimeJob,
  presentationRuntime,
  taskRuntime,
  unreleasedReservation,
} from "../runtime/activity.ts";
import {
  defaultIdFactory,
  readRuntimeState,
  runtimeFile,
  taskSessionDirectory,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableJob,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import { TaskControlWorkflow } from "../tasks/control.ts";
import type { TaskEvent, TaskTransitionContext } from "../tasks/lifecycle.ts";
import { createTaskStore, type TaskStore, transitionStoredTask } from "../tasks/store.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "../workers/terminal-control.ts";
import { WorkerWorkflow } from "../workers/workflow.ts";
import {
  absoluteDirectory,
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  isMissing,
  isMissingEndpoint,
  isOlderThan,
  isRecord,
  isTerminalTask,
  makeDurableJob,
  positiveInteger,
  readTextList,
  replaceRuntimeTask,
  singleLine,
  taskInputFor,
  taskNameFor,
  text,
  validateModelAssignments,
  workerRoleForTask,
} from "./records.ts";
import { mapTaskSource, SourceInboxWorkflow, taskSourcePath } from "./source.ts";

export type CreateTaskRequest = Readonly<{
  readonly repoPath: string;
  readonly kind: "scout" | "implementation";
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly surfaces: readonly string[];
}>;
export type ModelOptionsResult = Readonly<{
  readonly modelSettings: ModelSettings;
  readonly availableModels: readonly OmpModelRecord[];
}>;
export type TandemServiceOptions = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId?: string;
  readonly poolRoot?: string;
  readonly sourceWorkspace?: Readonly<{
    readonly repoPath: string;
    readonly path: string;
  }>;
  readonly workerTimeoutMs?: number;
  readonly run?: CommandRunner;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
}>;

export type TandemService = Readonly<{
  readonly onboard: (repoPath: string, write?: boolean) => Promise<OnboardRepoResult>;
  readonly models: (repoPath: string) => Promise<ModelOptionsResult>;
  readonly configureModels: (
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
    }>,
  ) => Promise<ModelSettings>;
  readonly create: (input: CreateTaskRequest) => Promise<TaskRecord>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly get: (id: string) => Promise<TaskRecord>;
  readonly approve: (id: string) => Promise<TaskRecord>;
  readonly tick: () => Promise<readonly TaskRecord[]>;
  readonly steer: (input: SteerTaskInput) => Promise<TaskCommunicationView>;
  readonly answer: (input: AnswerTaskInput) => Promise<TaskCommunicationView>;
  readonly messages: (taskId: string) => Promise<TaskCommunicationView>;
  readonly pause: (id: string, reason?: string) => Promise<TaskRecord>;
  readonly resume: (id: string) => Promise<TaskRecord>;
  readonly cancel: (id: string, reason?: string) => Promise<TaskRecord>;
  readonly acknowledge: (id: string, notificationId: string) => Promise<TaskRecord>;
  readonly describePr: (id: string, summary: PrSummary) => Promise<string>;
  readonly publish: (
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ) => Promise<TaskRecord>;
  readonly merge: (
    id: string,
    input: { readonly approved: boolean; readonly method?: "merge" | "squash" | "rebase" },
  ) => Promise<TaskRecord>;
  readonly cleanup: (
    id: string,
    input?: { readonly discard?: boolean; readonly destructiveApproval?: boolean },
  ) => Promise<TaskRecord>;
  readonly present: (
    id: string,
    input: { readonly objective: string; readonly artifacts: readonly string[] },
  ) => Promise<PresentationRecord>;
  readonly presentations: () => Promise<readonly PresentationRecord[]>;
  readonly feedback: (presentationId: string, signal?: AbortSignal) => Promise<PresentationRecord>;
  readonly shutdown: () => Promise<void>;
}>;

type ServiceDependencies = Readonly<{
  home: string;
  sessionId: string;
  parentWorkspaceId: string | undefined;
  poolRoot: string;
  sourceWorkspace:
    | Readonly<{
        repoPath: string;
        path: string;
      }>
    | undefined;
  workerTimeoutMs: number | undefined;
  run: CommandRunner;
  clock: Clock;
  idFactory: IdFactory;
  store: TaskStore;
  runtimePath: string;
  workerPath: string;
  validationWorkerPath: string;
}>;

function assertTaskId(id: unknown): string {
  return singleLine(id, "task id");
}

function assertArtifacts(artifacts: unknown): readonly string[] {
  return readTextList(artifacts, "artifacts");
}

class TandemController {
  readonly #deps: ServiceDependencies;
  readonly #source: SourceInboxWorkflow;
  readonly #presentationFeedback: PresentationFeedbackWorkflow;
  readonly #presentationRuntime: PresentationRuntimeWorkflow;
  readonly #worker: WorkerWorkflow;
  readonly #control: TaskControlWorkflow;
  #tickPromise: Promise<readonly TaskRecord[]> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  constructor(deps: ServiceDependencies) {
    this.#deps = deps;
    this.#source = new SourceInboxWorkflow({
      home: deps.home,
      sourceWorkspace: deps.sourceWorkspace,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
    });
    this.#presentationFeedback = new PresentationFeedbackWorkflow({
      store: deps.store,
      runtimePath: deps.runtimePath,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      readTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      failPresentation: (id, reason, releaseReservation, expectedJobId) =>
        this.#presentationRuntime.failPresentation(id, reason, releaseReservation, expectedJobId),
    });
    this.#presentationRuntime = new PresentationRuntimeWorkflow({
      sessionId: deps.sessionId,
      parentWorkspaceId: deps.parentWorkspaceId,
      workerPath: deps.workerPath,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
      readState: () => this.readState(),
      taskInScope: (task) => this.#source.taskInScope(task),
      feedback: this.#presentationFeedback,
    });
    this.#worker = new WorkerWorkflow({
      home: deps.home,
      sessionId: deps.sessionId,
      parentWorkspaceId: deps.parentWorkspaceId,
      poolRoot: deps.poolRoot,
      workerTimeoutMs: deps.workerTimeoutMs,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
      workerPath: deps.workerPath,
      validationWorkerPath: deps.validationWorkerPath,
      getTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      runtimeFor: (taskId) => this.runtimeFor(taskId),
      readState: () => this.readState(),
      resultExists: (path) => this.resultExists(path),
      updateTask: (taskId, transform) => this.updateTask(taskId, transform),
      transition: (taskId, event) => this.transition(taskId, event),
      context: () => this.context(),
      blockTask: (taskId, reason) => this.blockTask(taskId, reason),
      publishTaskInbox: (task) => this.#source.publishTaskInbox(task),
      removeEndpoint: (taskId, paneId) => this.removeEndpoint(taskId, paneId),
      setRuntimeError: (taskId, error) => this.setRuntimeError(taskId, error),
      maintainPoolForAllocation: (task) => this.maintainPoolForAllocation(task),
    });
    this.#control = new TaskControlWorkflow({
      store: deps.store,
      runtimePath: deps.runtimePath,
      sessionId: deps.sessionId,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      getTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      runtimeFor: (taskId) => this.runtimeFor(taskId),
      reconcileTask: (task) => this.reconcileTask(task),
      reconcileJob: (task, runtime, job) => this.#worker.reconcileJob(task, runtime, job),
      context: () => this.context(),
      transition: (taskId, event) => this.transition(taskId, event),
      blockTask: (taskId, reason) => this.blockTask(taskId, reason),
      publishTaskInbox: (task) => this.#source.publishTaskInbox(task),
      setRuntimeError: (taskId, error) => this.setRuntimeError(taskId, error),
      saveEndpoint: (taskId, endpoint) => this.#worker.saveEndpoint(taskId, endpoint),
    });
  }

  api(): TandemService {
    return {
      onboard: (repoPath, write) => this.onboard(repoPath, write),
      models: (repoPath) => this.models(repoPath),
      configureModels: (input) => this.configureModels(input),
      create: (input) => this.create(input),
      list: () => this.list(),
      get: (id) => this.get(id),
      approve: (id) => this.approve(id),
      tick: () => this.tick(),
      steer: (input) => this.steer(input),
      answer: (input) => this.answer(input),
      messages: (taskId) => this.messages(taskId),
      pause: (id, reason) => this.pause(id, reason),
      resume: (id) => this.resume(id),
      cancel: (id, reason) => this.cancel(id, reason),
      acknowledge: (id, notificationId) => this.acknowledge(id, notificationId),
      describePr: (id, summary) => this.describePr(id, summary),
      publish: (id, input) => this.publish(id, input),
      merge: (id, input) => this.merge(id, input),
      cleanup: (id, input) => this.cleanup(id, input),
      present: (id, input) => this.present(id, input),
      presentations: () => this.presentations(),
      feedback: (id, signal) => this.feedback(id, signal),
      shutdown: () => this.shutdown(),
    };
  }

  async onboard(repoPath: string, write = false): Promise<OnboardRepoResult> {
    const source = await mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
    return onboardRepo({
      repoPath: source.repoPath,
      home: this.#deps.home,
      write,
      ...(source.sourceRepoPath === undefined ? {} : { checkoutPath: source.sourceRepoPath }),
    });
  }
  async models(repoPath: string): Promise<ModelOptionsResult> {
    const source = await mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
    const modelSettings = await readModelSettings({
      repoPath: source.repoPath,
      home: this.#deps.home,
    });
    const availableModels = await listOmpModels(this.#deps.run, { cwd: source.checkoutPath });
    return { modelSettings, availableModels };
  }

  async configureModels(
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
    }>,
  ): Promise<ModelSettings> {
    if (!isRecord(input)) throw new TypeError("configureModels input must be an object");
    const source = await mapTaskSource(this.#deps.run, input.repoPath, this.#deps.sourceWorkspace);
    const models = parseModelAssignments(input.models);
    const availableModels = await listOmpModels(this.#deps.run, { cwd: source.checkoutPath });
    validateModelAssignments(models, availableModels);
    return writeModelSettings({
      repoPath: source.repoPath,
      home: this.#deps.home,
      models,
    });
  }

  async create(input: CreateTaskRequest): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("create input must be an object");
    const source = await mapTaskSource(this.#deps.run, input.repoPath, this.#deps.sourceWorkspace);
    const policy = await resolveRepoPolicy({
      repoPath: source.repoPath,
      home: this.#deps.home,
      ...(source.sourceRepoPath === undefined ? {} : { checkoutPath: source.sourceRepoPath }),
    });
    const checkpoint = await readCheckpoint(this.#deps.run, { repo: source.checkoutPath });
    const taskInput = taskInputFor(input, source.repoPath, policy);
    const id = singleLine(this.#deps.idFactory(), "task id");
    const task = await this.#deps.store.exclusive(async (store) => {
      const created = await store.create({ ...taskInput, id });
      const current = await readRuntimeState(this.#deps.runtimePath);
      const runtimeTask: RuntimeTaskState = {
        schemaVersion: 1,
        taskId: created.id,
        sourceCheckpoint: checkpoint,
        taskName: taskNameFor(created),
        endpoints: [],
        jobs: [],
        ...(source.sourceRepoPath === undefined ? {} : { sourceRepoPath: source.sourceRepoPath }),
        ...(created.kind === "implementation"
          ? { sessionDirectory: taskSessionDirectory(this.#deps.home, created.id) }
          : {}),
      };
      if (current.tasks.some((entry) => entry.taskId === created.id)) {
        throw new Error(`runtime state already contains task ${created.id}`);
      }
      await writeRuntimeState(this.#deps.runtimePath, {
        ...current,
        tasks: [...current.tasks, runtimeTask],
      });
      return created;
    });
    return task;
  }

  async list(): Promise<readonly TaskRecord[]> {
    return this.#source.scopedTasks();
  }

  async get(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.#deps.store.read(taskId);
    if (task === undefined || !(await this.#source.taskInScope(task))) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  async approve(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (task.kind === "implementation") {
      const runtime = await this.runtimeFor(task.id);
      if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
      const current = await readCheckpoint(this.#deps.run, {
        repo: taskSourcePath(task, runtime),
      });
      this.#worker.assertSourceUnchanged(runtime.sourceCheckpoint, current);
    }
    return this.transition(task.id, { type: "approve" });
  }

  async tick(): Promise<readonly TaskRecord[]> {
    const existing = this.#tickPromise;
    if (existing !== undefined) return existing;
    const current = this.advance().finally(() => {
      this.#tickPromise = undefined;
    });
    this.#tickPromise = current;
    return current;
  }

  async pause(id: string, reason = "paused by coordinator"): Promise<TaskRecord> {
    return this.#control.controlTask(assertTaskId(id), "pause", text(reason, "reason"));
  }

  async resume(id: string): Promise<TaskRecord> {
    return this.#control.resumeTask(assertTaskId(id));
  }

  async cancel(id: string, reason?: string): Promise<TaskRecord> {
    return this.#control.controlTask(
      assertTaskId(id),
      "cancel",
      reason === undefined ? undefined : text(reason, "reason"),
    );
  }

  async acknowledge(id: string, notificationId: string): Promise<TaskRecord> {
    const task = await this.get(id);
    return this.transition(task.id, {
      type: "acknowledge-notification",
      notificationId: singleLine(notificationId, "notificationId"),
    });
  }
  async steer(input: SteerTaskInput): Promise<TaskCommunicationView> {
    if (!isRecord(input)) throw new TypeError("steer input must be an object");
    const taskId = assertTaskId(input.taskId);
    const before = await this.get(taskId);
    const value = singleLine(input.text, "text");
    const instruction =
      input.supersedes === undefined
        ? { text: value }
        : {
            text: value,
            supersedes: input.supersedes.map((entry, index) =>
              singleLine(entry, `supersedes[${index}]`),
            ),
          };
    const next = await this.#control.redirectToPrimary(taskId, instruction);
    if (next.stage === "implementing" && next.generation !== before.generation) {
      await this.reconcileTask(await this.get(next.id));
    } else if (next.stage === "completed" && next.kind === "scout") {
      const followUp = await this.transition(next.id, { type: "follow-up-research" });
      await this.reconcileTask(followUp);
    }
    return this.messages(taskId);
  }

  async answer(input: AnswerTaskInput): Promise<TaskCommunicationView> {
    if (!isRecord(input)) throw new TypeError("answer input must be an object");
    const taskId = assertTaskId(input.taskId);
    const questionId = singleLine(input.questionId, "questionId");
    const answer = singleLine(input.text, "text");
    const result = await this.#source.appendAnswer(taskId, questionId, answer);
    if (result.resumed) await this.#control.resumeTask(taskId);
    return this.messages(taskId);
  }

  async messages(taskId: string): Promise<TaskCommunicationView> {
    const id = assertTaskId(taskId);
    await this.get(id);
    try {
      await this.#source.repairTaskInbox(id);
    } catch {
      // Canonical communication remains readable even when projection repair is unavailable.
    }
    return this.#source.communicationView(await this.get(id));
  }

  async describePr(id: string, summary: PrSummary): Promise<string> {
    const task = await this.get(id);
    return describeTaskPr(task, summary);
  }

  async publish(
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("publish input must be an object");
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(id);
      if (task === undefined || !(await this.#source.taskInScope(task))) {
        throw new Error(`Task ${id} was not found`);
      }
      const metadata = await publishReviewedTask({
        task,
        summary: input.summary,
        repository: singleLine(input.repository, "repository"),
        title: singleLine(input.title, "title"),
        base: singleLine(input.base, "base"),
        approved: input.approved,
        run: this.#deps.run,
      });
      return store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: this.#deps.clock(),
        pullRequest: metadata,
      }));
    });
  }

  async merge(
    id: string,
    input: { readonly approved: boolean; readonly method?: "merge" | "squash" | "rebase" },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("merge input must be an object");
    const task = await this.get(id);
    const method = input.method ?? "merge";
    const metadata = await mergeReviewedTask({
      task,
      approved: input.approved,
      method,
      run: this.#deps.run,
    });
    return this.transition(task.id, {
      type: "merge",
      pullRequest: metadata,
      approved: input.approved,
      verified: metadata.state === "merged" && metadata.head === task.reviewHead,
    });
  }

  async cleanup(
    id: string,
    input: { readonly discard?: boolean; readonly destructiveApproval?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = await this.get(id);
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
    const discard = input.discard === true;
    if (discard && input.destructiveApproval !== true) {
      throw new Error("destructive cleanup requires explicit destructiveApproval=true");
    }
    if (runtime.endpointLaunch !== undefined) {
      throw new Error(`cannot clean task ${task.id} while endpoint startup is unresolved`);
    }
    if (runtime.jobs.some(activeRuntimeJob)) {
      throw new Error(`cannot clean task ${task.id} while a worker launch is in progress`);
    }
    const cwd = taskSourcePath(task, runtime);
    for (const endpoint of runtime.endpoints) {
      try {
        const job = workerJobForEndpoint(runtime.jobs, endpoint);
        await prepareWorkerTerminal(this.#deps.run, {
          endpoint,
          cwd,
          ...(job === undefined ? {} : { job }),
        });
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    for (const endpoint of runtime.endpoints) {
      try {
        await closeEndpoint(this.#deps.run, {
          endpoint,
          cwd: taskSourcePath(task, runtime),
        });
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    if (runtime.worktree !== undefined) {
      await releaseWorktree(this.#deps.run, {
        repo: task.repoPath,
        lease: runtime.worktree,
        childWorkerStopped: true,
        ...(discard ? { discard: true, destructiveApproval: true } : {}),
      });
    }
    await this.removeRuntimeResources(task.id);
    return task;
  }

  async present(
    id: string,
    input: { readonly objective: string; readonly artifacts: readonly string[] },
  ): Promise<PresentationRecord> {
    if (!isRecord(input)) throw new TypeError("presentation input must be an object");
    const task = await this.get(id);
    const presentationId = singleLine(this.#deps.idFactory(), "presentation id");
    const prepared = await preparePresentation({
      task,
      id: presentationId,
      directory: join(this.#deps.home, "presentations", presentationId),
      objective: text(input.objective, "objective"),
      artifacts: assertArtifacts(input.artifacts),
      now: this.#deps.clock(),
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      run: this.#deps.run,
    });
    const recordPath = join(dirname(prepared.record.jobPath), "record.json");
    await writeJsonAtomically(recordPath, prepared.record);
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      prepared.record.generation,
      "presentation",
      "worker",
      prepared.record.cwd,
      prepared.record.jobPath,
      prepared.record.resultPath,
      1,
      this.#deps.clock(),
    );
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      if (presentationRuntime(state, prepared.record.id) !== undefined) {
        throw new Error(`presentation ${prepared.record.id} already exists`);
      }
      const next: RuntimePresentation = {
        schemaVersion: 1,
        id: prepared.record.id,
        taskId: task.id,
        recordPath,
        job: durableJob,
      };
      await writeRuntimeState(this.#deps.runtimePath, {
        ...state,
        presentations: [...state.presentations, next],
      });
    });
    await this.#presentationRuntime.startPresentation(prepared.record.id);
    return this.readPresentation(prepared.record.id);
  }

  async presentations(): Promise<readonly PresentationRecord[]> {
    const state = await this.readState();
    const taskIds = new Set((await this.#source.scopedTasks()).map((task) => task.id));
    const records: PresentationRecord[] = [];
    for (const entry of state.presentations) {
      if (!taskIds.has(entry.taskId)) continue;
      records.push(await readPresentationRecord(entry.recordPath));
    }
    return records;
  }

  async feedback(presentationId: string, signal?: AbortSignal): Promise<PresentationRecord> {
    return this.#presentationFeedback.feedback(presentationId, signal);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const tick = this.#tickPromise;
    const presentation = this.#presentationFeedback.shutdown();
    const inFlight = [...(tick === undefined ? [] : [tick]), presentation];
    const shutdown = Promise.allSettled(inFlight).then(() => undefined);
    this.#shutdownPromise = shutdown;
    await shutdown;
  }

  private async advance(): Promise<readonly TaskRecord[]> {
    const tasks = await this.#source.scopedTasks();
    for (const task of tasks) {
      try {
        await this.reconcileTask(task);
      } catch (error) {
        await this.blockTask(task.id, `scheduler failure: ${describeError(error)}`);
      }
      try {
        const current = await this.get(task.id);
        if (isTerminalTask(current)) await this.cleanupTerminalTask(current);
      } catch (error) {
        await this.setRuntimeError(task.id, `terminal cleanup failed: ${describeError(error)}`);
      }
    }
    const state = await this.readState();
    const scopedTaskIds = new Set(tasks.map((task) => task.id));
    for (const presentation of state.presentations) {
      if (!scopedTaskIds.has(presentation.taskId)) continue;
      try {
        await this.#presentationRuntime.reconcilePresentation(presentation);
      } catch (error) {
        await this.#presentationRuntime.failPresentation(
          presentation.id,
          describeError(error),
          true,
          presentation.job.id,
        );
      }
    }
    return this.#source.scopedTasks();
  }

  private async reconcileTask(task: TaskRecord): Promise<void> {
    try {
      await this.#source.repairTaskInbox(task.id);
    } catch {
      // Canonical task state remains authoritative when projection repair is unavailable.
    }
    const loadedRuntime = await this.runtimeFor(task.id);
    if (loadedRuntime === undefined) {
      await this.blockTask(task.id, "durable runtime metadata is missing; no worker was launched");
      return;
    }
    let runtime = loadedRuntime;
    if (runtime.endpointLaunch !== undefined && currentWriter(runtime) === undefined) {
      const recovered = await this.#control.reconcileEndpointLaunch(task, runtime);
      if (recovered === undefined) return;
      runtime = recovered;
    }
    if (runtime.stopRequest !== undefined) {
      await this.#control.reconcileStopRequest(task, runtime);
      return;
    }
    const active = runtime.jobs.find(activeRuntimeJob);
    if (active !== undefined) {
      await this.#worker.reconcileJob(task, runtime, active);
      return;
    }
    if (unreleasedReservation(runtime.reservation)) {
      const reservation = runtime.reservation;
      const writer = currentWriter(runtime);
      if (
        reservation.ownerSessionId === this.#deps.sessionId &&
        runtime.worktree !== undefined &&
        writer !== undefined
      ) {
        if (task.stage === "queued") {
          await this.#worker.startQueuedTask(task, { task, runtime, reservation });
          return;
        }
        if (task.stage === "scouting" || task.stage === "implementing") {
          await this.#worker.launchAgent(task, runtime, writer, workerRoleForTask(task));
          return;
        }
      }
      if (isOlderThan(reservation.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.blockTask(
          task.id,
          "an owned scheduler reservation has no recoverable job intent",
        );
      }
      return;
    }
    switch (task.stage) {
      case "queued":
        await this.#worker.startQueuedTask(task);
        return;
      case "awaiting-fixes":
        await this.#worker.beginFixes(task);
        return;
      case "validating":
        await this.#worker.startValidation(task);
        return;
      case "reviewing":
        await this.#worker.advanceReview(task);
        return;
      case "scouting":
      case "implementing": {
        if (runtime.endpointLaunch !== undefined) return;
        if (runtime.worktree === undefined) {
          await this.blockTask(
            task.id,
            `task is ${task.stage} but its durable worktree is missing`,
          );
          return;
        }
        const writer = currentWriter(runtime);
        if (writer === undefined) {
          await this.blockTask(task.id, `task is ${task.stage} but its worker endpoint is missing`);
          return;
        }
        const admission = await this.#worker.reserveTask(task.id, workerRoleForTask(task));
        if (admission === undefined) return;
        const admittedWriter = currentWriter(admission.runtime);
        if (admission.runtime.worktree === undefined || admittedWriter === undefined) {
          await this.#worker.releaseUnlaunchedTaskReservation(task.id, admission.reservation.id);
          await this.blockTask(
            task.id,
            `task is ${task.stage} but its worker resources are missing`,
          );
          return;
        }
        await this.#worker.launchAgent(
          admission.task,
          admission.runtime,
          admittedWriter,
          workerRoleForTask(admission.task),
        );
        return;
      }
      default:
        return;
    }
  }

  private async recordPoolResult(taskId: string, result: PoolMaintenanceResult): Promise<void> {
    const admissionKey = poolAdmissionKey(result);
    const admissionNotice = admissionKey === undefined ? undefined : poolAdmissionNotice(result);
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#source.taskInScope(task))) return;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      const previousKey = runtime?.poolAdmissionKey;
      const nextRuntime =
        runtime === undefined
          ? state
          : replaceRuntimeTask(state, taskId, (current) => {
              if (admissionKey === undefined) {
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
              return {
                ...current,
                poolAdmissionKey: admissionKey,
                poolNotice: notice,
                lastError: notice,
              };
            });
      const notificationMessage =
        admissionKey === undefined || admissionNotice === undefined
          ? undefined
          : poolNotificationMessage(admissionKey, admissionNotice);
      const hasNotification =
        admissionKey !== undefined &&
        task.notifications.some((entry) => isPoolNotificationForKey(entry, admissionKey));
      const shouldNotify =
        task.stage === "queued" &&
        notificationMessage !== undefined &&
        previousKey !== admissionKey &&
        !hasNotification;
      const recoveredNotifications =
        admissionKey === undefined
          ? task.notifications.filter((entry) => !isPoolNotification(entry))
          : task.notifications;
      const taskWithNotification: TaskRecord =
        shouldNotify && notificationMessage !== undefined
          ? {
              ...task,
              revision: task.revision + 1,
              updatedAt: this.#deps.clock(),
              notifications: [
                ...task.notifications,
                {
                  id: singleLine(this.#deps.idFactory(), "pool notification id"),
                  message: notificationMessage,
                  acknowledged: false,
                },
              ],
            }
          : recoveredNotifications.length === task.notifications.length
            ? task
            : {
                ...task,
                revision: task.revision + 1,
                updatedAt: this.#deps.clock(),
                notifications: recoveredNotifications,
              };
      if (taskWithNotification !== task) {
        await store.update(task.id, task.revision, () => taskWithNotification);
      }
      if (runtime !== undefined) await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
    });
  }
  private async maintainPoolForAllocation(task: TaskRecord): Promise<boolean> {
    const [state, tasks] = await Promise.all([this.readState(), this.#deps.store.list()]);
    const sourceRepoPath = taskRuntime(state, task.id)?.sourceRepoPath ?? task.repoPath;
    const managedPaths = tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    const protectedPaths = state.tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    let result: PoolMaintenanceResult;
    try {
      result = await maintainPool(this.#deps.run, {
        repo: sourceRepoPath,
        root: this.#deps.poolRoot,
        managedPaths,
        protectedPaths,
        retainIdle: Math.max(0, task.policy.config.maxWorkers - activeReservations(state)),
      });
    } catch (error) {
      await this.recordPoolResult(task.id, {
        canAllocate: false,
        availableBytes: null,
        removedPaths: [],
        retainedPaths: managedPaths,
        warnings: [],
        allocationBlocker: `pool maintenance failed: ${describeError(error)}`,
      });
      return false;
    }
    await this.recordPoolResult(task.id, result);
    return result.canAllocate;
  }

  private async cleanupTerminalTask(task: TaskRecord): Promise<void> {
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) return;
    if (runtime.endpointLaunch !== undefined || runtime.jobs.some(activeRuntimeJob)) return;
    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
    for (const endpoint of runtime.endpoints) {
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        if (inspection.activeWorker) return;
        await closeEndpoint(this.#deps.run, { endpoint, cwd });
      } catch (error) {
        if (!isMissingEndpoint(error)) {
          await this.setRuntimeError(
            task.id,
            `terminal cleanup could not close pane ${endpoint.paneId}: ${describeError(error)}`,
          );
          return;
        }
      }
      await this.removeEndpoint(task.id, endpoint.paneId);
    }
    if (runtime.worktree !== undefined) {
      try {
        await releaseWorktree(this.#deps.run, {
          repo: task.repoPath,
          lease: runtime.worktree,
          childWorkerStopped: true,
        });
      } catch (error) {
        await this.setRuntimeError(
          task.id,
          `terminal cleanup retained worktree: ${describeError(error)}`,
        );
        return;
      }
    }
    await this.removeRuntimeResources(task.id, task.revision);
  }

  private async removeEndpoint(taskId: string, paneId: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        endpoints: current.endpoints.filter((endpoint) => endpoint.paneId !== paneId),
      })),
    );
    await this.updateTask(taskId, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      endpoints: (current.endpoints ?? []).filter((endpoint) => endpoint.paneId !== paneId),
    }));
  }

  private async setRuntimeError(taskId: string, error: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) =>
        current.lastError === error ? current : { ...current, lastError: error },
      ),
    );
  }

  private async transition(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    const task = await this.get(taskId);
    const context = this.context();
    return transitionStoredTask(this.#deps.store, taskId, task.revision, event, context);
  }

  private context(): TaskTransitionContext {
    return {
      now: this.#deps.clock(),
      notificationId: singleLine(this.#deps.idFactory(), "notification id"),
    };
  }

  private async updateTask(
    taskId: string,
    transform: (task: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    const current = await this.get(taskId);
    return this.#deps.store.update(taskId, current.revision, transform);
  }

  private async blockTask(taskId: string, reason: string): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (["cancelled", "completed", "merged", "paused", "blocked"].includes(task.stage)) return task;
    return this.transition(taskId, { type: "block", reason: text(reason, "block reason") });
  }

  private async resultExists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  private async removeRuntimeResources(taskId: string, terminalRevision?: number): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        const {
          endpointLaunch: _endpointLaunch,
          stopRequest: _stopRequest,
          lastError: _lastError,
          poolAdmissionKey: _poolAdmissionKey,
          poolNotice: _poolNotice,
          worktree: _worktree,
          ...withoutTransientState
        } = current;
        return {
          ...withoutTransientState,
          ...(current.reservation === undefined
            ? {}
            : {
                reservation: {
                  ...current.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              }),
          endpoints: [],
          ...(terminalRevision === undefined ? {} : { terminalCleanupRevision: terminalRevision }),
        };
      }),
    );
  }

  private async runtimeFor(taskId: string): Promise<RuntimeTaskState | undefined> {
    const state = await this.readState();
    return taskRuntime(state, taskId);
  }

  private async readState(): Promise<RuntimeState> {
    return this.#deps.store.exclusive(() => readRuntimeState(this.#deps.runtimePath));
  }
  private async readPresentation(id: string): Promise<PresentationRecord> {
    const state = await this.readState();
    const runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    return readPresentationRecord(runtime.recordPath);
  }
}

function serviceDependencies(options: TandemServiceOptions): ServiceDependencies {
  if (!isRecord(options)) throw new TypeError("TandemServiceOptions must be an object");
  const home = absoluteDirectory(options.home, "home");
  const sessionId = singleLine(options.sessionId, "sessionId");
  const poolRoot =
    options.poolRoot === undefined
      ? join(home, "pool")
      : absoluteDirectory(options.poolRoot, "poolRoot");
  const sourceWorkspace =
    options.sourceWorkspace === undefined
      ? undefined
      : (() => {
          if (!isRecord(options.sourceWorkspace)) {
            throw new TypeError("sourceWorkspace must be an object");
          }
          const repoPath = absoluteDirectory(
            options.sourceWorkspace.repoPath,
            "sourceWorkspace.repoPath",
          );
          const path = absoluteDirectory(options.sourceWorkspace.path, "sourceWorkspace.path");
          if (repoPath === path) {
            throw new TypeError("sourceWorkspace must identify a distinct clean checkout");
          }
          return { repoPath, path };
        })();
  const workerTimeoutMs =
    options.workerTimeoutMs === undefined
      ? undefined
      : positiveInteger(options.workerTimeoutMs, "workerTimeoutMs");
  const run = options.run ?? runCommand;
  if (typeof run !== "function") throw new TypeError("run must be a command runner");
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory();
  if (typeof clock !== "function" || typeof idFactory !== "function")
    throw new TypeError("clock and idFactory must be functions");
  return {
    home,
    sessionId,
    parentWorkspaceId:
      options.parentWorkspaceId === undefined
        ? undefined
        : singleLine(options.parentWorkspaceId, "parentWorkspaceId"),
    poolRoot,
    sourceWorkspace,
    workerTimeoutMs,
    run,
    clock,
    idFactory,
    store: createTaskStore({ directory: join(home, "tasks"), clock, idFactory }),
    runtimePath: runtimeFile(home),
    workerPath: fileURLToPath(new URL("../worker.ts", import.meta.url)),
    validationWorkerPath: fileURLToPath(new URL("../validation-worker.ts", import.meta.url)),
  };
}

export function createTandemService(options: TandemServiceOptions): TandemService {
  return new TandemController(serviceDependencies(options)).api();
}
