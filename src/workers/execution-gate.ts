import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ModelSpec, TaskRecord } from "../contracts.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../runtime/persistence.ts";
import type { DurableJob, DurableOperation } from "../runtime/schema.ts";
import { createTaskStore, type TaskStore, type TaskStoreTransaction } from "../tasks/store.ts";
import { authorizeExecutionModel, executionRoutingFence } from "./execution-routing.ts";

export type ExecutionIdentity = Readonly<{
  readonly schemaVersion: 1;
  readonly home: string;
  readonly operationId: string;
  readonly fencingRevision: number;
  readonly claimOwner: string;
}>;

export type ExecutionGateInput = Readonly<{
  readonly execution: ExecutionIdentity;
  readonly jobId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly command: "worker" | "validation";
  readonly cwd: string;
  readonly resultPath: string;
  readonly inputHead?: string;
  /** The exact model this execution will invoke; absent only for model-free validation runs. */
  readonly resolvedModel?: ModelSpec;
}>;

export type ExecutionAdmission = Readonly<{
  readonly admitted: boolean;
  readonly reason?: string;
}>;

export type ExecutionGateOptions = Readonly<{
  readonly store?: TaskStore;
  readonly now?: () => string;
  readonly claim?: (
    input: ExecutionGateInput,
  ) => ExecutionAdmission | PromiseLike<ExecutionAdmission>;
}>;

function refusal(reason: string): ExecutionAdmission {
  return { admitted: false, reason };
}

function activeTask(task: TaskRecord): boolean {
  return !["paused", "blocked", "cancelled", "completed", "merged"].includes(task.stage);
}

function operationEffectId(jobId: string): string {
  return `execution:${jobId}`;
}

function executionIdentity(input: ExecutionGateInput): string {
  return `${input.execution.operationId}:${input.jobId}:${input.execution.fencingRevision}:${input.execution.claimOwner}`;
}

/**
 * Why this execution may not invoke the model its job names, or nothing when it may. Model-free
 * validation runs carry no model and are not routed; every other role is held to the transition
 * recorded on its operation, falling back to the pinned role assignment when none changed it.
 */
function refusedExecutionModel(
  task: TaskRecord,
  job: DurableJob,
  operation: DurableOperation,
  claimed: ModelSpec | undefined,
): string | undefined {
  const role = job.role;
  if (role === "validation") {
    return claimed === undefined ? undefined : "validation execution carries no resolved model";
  }
  // ponytail: a job admitted before the verifier role was removed carries no pinned model to
  // authorize against (the role no longer has one); let its already-started execution proceed.
  if (role === "verifier") return undefined;
  const authorization = authorizeExecutionModel({
    claimed,
    pinned: task.policy.config.models[role],
    routing: operation.routing,
    fence: executionRoutingFence(operation, job.id),
  });
  return authorization.authorized ? undefined : authorization.reason;
}

async function claimInTransaction(
  transaction: TaskStoreTransaction,
  input: ExecutionGateInput,
  now: () => string,
  runtimePath: string,
): Promise<ExecutionAdmission> {
  const task = await transaction.read(input.taskId);
  if (task === undefined) return refusal(`task ${input.taskId} is missing`);
  if (task.generation !== input.generation) return refusal("task generation is stale");
  if (!activeTask(task)) return refusal(`task ${input.taskId} is not active`);
  const state = await readRuntimeState(runtimePath);

  const taskRuntime = state.tasks.find((entry) => entry.taskId === input.taskId);
  if (taskRuntime === undefined) return refusal(`runtime task ${input.taskId} is missing`);
  const job = taskRuntime.jobs.find((entry) => entry.id === input.jobId);
  if (job === undefined) return refusal(`runtime job ${input.jobId} is missing`);
  if (
    job.id !== input.jobId ||
    job.taskId !== input.taskId ||
    job.generation !== input.generation
  ) {
    return refusal("runtime job identity is stale");
  }
  if (
    (input.command === "validation" && job.kind !== "validation") ||
    (input.command !== "validation" && job.kind !== "worker")
  ) {
    return refusal("runtime job kind does not match execution command");
  }
  if (
    (input.command === "validation" && job.role !== "validation") ||
    (input.command === "worker" && (job.role === "validation" || job.role === "presentation"))
  ) {
    return refusal("runtime job role does not match execution command");
  }
  if (
    resolve(job.cwd) !== resolve(input.cwd) ||
    resolve(job.resultPath) !== resolve(input.resultPath)
  ) {
    return refusal("execution paths do not match the admitted job");
  }
  if (job.operationId !== input.execution.operationId)
    return refusal("job operation identity is stale");
  if (!job.launchAttempted || (job.phase !== "launching" && job.phase !== "running")) {
    return refusal("job is not in an admitted launch state");
  }

  const operation = taskRuntime.operation;
  if (operation === undefined) return refusal("runtime operation is missing");
  const operationKind = operation.kind;
  if (
    (input.command === "validation" && operationKind !== "validation") ||
    (input.command === "worker" &&
      (operationKind === "validation" || operationKind === "presentation")) ||
    operation.role !== job.role
  ) {
    return refusal("runtime operation role or kind does not match the job");
  }
  if (
    operation.id !== input.execution.operationId ||
    operation.taskId !== input.taskId ||
    operation.jobId !== input.jobId ||
    operation.generation !== input.generation ||
    operation.claimOwner !== input.execution.claimOwner ||
    operation.fencingRevision !== input.execution.fencingRevision
  ) {
    return refusal("execution fence is stale");
  }
  if (operation.phase !== "launching" && operation.phase !== "running") {
    return refusal("operation is not admitted for execution");
  }
  if (
    state.tasks.some((entry) => entry.taskId === input.taskId && entry.stopRequest !== undefined)
  ) {
    return refusal("task has a durable stop request");
  }
  if (input.inputHead !== undefined && operation.inputHead !== input.inputHead) {
    return refusal("execution input checkpoint is stale");
  }
  const modelRefusal = refusedExecutionModel(task, job, operation, input.resolvedModel);
  if (modelRefusal !== undefined) return refusal(modelRefusal);
  const claimId = operationEffectId(input.jobId);
  if (operation.effects.some((effect) => effect.id === claimId)) {
    return refusal("execution claim already exists");
  }

  const claimedOperation: DurableOperation = {
    ...operation,
    effects: [
      ...operation.effects,
      {
        id: claimId,
        kind: "worker",
        phase: "started",
        createdAt: now(),
        identity: executionIdentity(input),
        receipt: input.resultPath,
      },
    ],
  };
  await writeRuntimeState(runtimePath, {
    ...state,
    tasks: state.tasks.map((entry) =>
      entry.taskId === input.taskId ? { ...entry, operation: claimedOperation } : entry,
    ),
  });
  return { admitted: true };
}

export async function claimExecutionStart(
  input: ExecutionGateInput,
  options: ExecutionGateOptions = {},
): Promise<ExecutionAdmission> {
  if (options.claim !== undefined) return options.claim(input);
  const home = resolve(input.execution.home);
  const store =
    options.store ??
    createTaskStore({
      directory: join(home, "tasks"),
      clock: options.now ?? (() => new Date().toISOString()),
      idFactory: randomUUID,
    });
  const now = options.now ?? (() => new Date().toISOString());
  return store.exclusive((transaction) =>
    claimInTransaction(transaction, input, now, runtimeFile(home)),
  );
}
