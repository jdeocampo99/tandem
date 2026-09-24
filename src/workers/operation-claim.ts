import type { DurableOperation, RuntimeTaskState } from "../runtime/schema.ts";
import type { ExecutionIdentity } from "./execution-gate.ts";

/** The fence one workflow step holds on a task's durable operation. */
export type OperationClaim = Readonly<{
  readonly id: string;
  readonly fencingRevision: number;
  readonly claimOwner: string;
}>;

export function claimOf(operation: DurableOperation | undefined): OperationClaim | undefined {
  return operation === undefined
    ? undefined
    : {
        id: operation.id,
        fencingRevision: operation.fencingRevision,
        claimOwner: operation.claimOwner,
      };
}

/** Whether `operation` is still the one `claim` fenced: same id, owner, and fencing revision. */
export function holdsClaim(
  operation: DurableOperation | undefined,
  claim: OperationClaim,
): operation is DurableOperation {
  return (
    operation !== undefined &&
    operation.id === claim.id &&
    operation.claimOwner === claim.claimOwner &&
    operation.fencingRevision === claim.fencingRevision
  );
}

/** Like `holdsClaim`, except that no claim owns exactly a runtime with no operation. */
export function ownsOperation(
  operation: DurableOperation | undefined,
  claim: OperationClaim | undefined,
): boolean {
  return claim === undefined ? operation === undefined : holdsClaim(operation, claim);
}

const SETTLED_OPERATION_PHASES: readonly DurableOperation["phase"][] = [
  "completed",
  "failed",
  "quarantined",
  "cancelled",
];

/** Whether the operation has reached an outcome no further workflow step may change. */
export function operationSettled(operation: DurableOperation): boolean {
  return SETTLED_OPERATION_PHASES.includes(operation.phase);
}

/** The identity a worker or validation job spec carries so its runner can prove its fence. */
export function executionIdentity(home: string, operation: DurableOperation): ExecutionIdentity {
  return {
    schemaVersion: 1,
    home,
    operationId: operation.id,
    fencingRevision: operation.fencingRevision,
    claimOwner: operation.claimOwner,
  };
}

/** The task's operation, or a throw when `claim` no longer fences it. */
export function claimedOperation(
  runtime: RuntimeTaskState,
  taskId: string,
  claim: OperationClaim,
): DurableOperation {
  if (!holdsClaim(runtime.operation, claim)) {
    throw new Error(`runtime task ${taskId} operation claim was fenced`);
  }
  return runtime.operation;
}
