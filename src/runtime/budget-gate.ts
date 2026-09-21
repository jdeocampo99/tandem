/**
 * The one entry point work goes through before it is allowed to spend, and the one place a
 * spending decision is answered.
 *
 * Admission decides and hands its caller the budget record to persist; it writes nothing itself,
 * so a reservation lands in the same atomic runtime write as the operation it backs and a second
 * concurrent admission sees it. Reading a request's budget and reconciling its reservations are
 * passive: they start no provider work and ask no question.
 */

import type { Clock, TaskRecord } from "../contracts.ts";
import { policyIdentity } from "../tasks/acceptance.ts";
import type { TaskStore } from "../tasks/store.ts";
import {
  authorizeRequestSpend,
  decideRequestSpendAdmission,
  observeRequestCharges,
  type RequestChargeObservation,
  type RequestOperationSettlement,
  type RequestSpendAdmission,
  type RequestSpendAuthorization,
  type RequestSpendIdentity,
  type RequestSpendReadout,
  reconcileRequestBudgetReservations,
  requestBudgetFor,
  requestSpendReadout,
  withRequestBudget,
} from "./budget.ts";
import { readRuntimeState, updateRuntimeState } from "./persistence.ts";
import type { RuntimeState } from "./schema.ts";
import type { RequestUsageReadout } from "./usage-receipt.ts";

/** One operation asking to start, with the runtime state its caller already holds the lock over. */
export type RequestSpendAdmissionRequest = Readonly<{
  readonly task: TaskRecord;
  readonly state: RuntimeState;
  readonly operationId: string;
}>;

export type RequestSpendReconciliation = Readonly<{
  readonly requestId: string;
  readonly settlements: readonly RequestOperationSettlement[];
}>;

export type RequestSpendGate = Readonly<{
  /**
   * Decides whether one operation may start, or returns `undefined` when the operation is not
   * spend-governed: no request governs the task, or no cap governs that request. The caller
   * persists `admission.budget` with its own runtime write; nothing is reserved until it does.
   */
  readonly decideAdmission: (
    request: RequestSpendAdmissionRequest,
  ) => Promise<RequestSpendAdmission | undefined>;
  /** Everything a spending decision needs, read without changing anything. */
  readonly readSpend: (requestId: string) => Promise<RequestSpendReadout>;
  /** Records an explicit cap increase answering one pending decision, and lifts that pause. */
  readonly authorizeSpend: (intent: RequestSpendAuthorization) => Promise<RequestSpendReadout>;
  /** Settles reservations against the operations they back; retains whatever is still uncertain. */
  readonly reconcileReservations: (input: RequestSpendReconciliation) => Promise<void>;
}>;

export type RequestSpendGateDependencies = Readonly<{
  readonly runtimePath: string;
  readonly store: TaskStore;
  readonly clock: Clock;
  /** The accounting ledger's own rows for one request; this gate never writes usage. */
  readonly readRequestUsage: (requestId: string) => Promise<RequestUsageReadout>;
  /** The brief revision a budget decision is bound to: the approved one while it stands. */
  readonly readAgreementRevision: (requestId: string) => Promise<number>;
}>;

export function createRequestSpendGate(deps: RequestSpendGateDependencies): RequestSpendGate {
  const observe = async (requestId: string): Promise<RequestChargeObservation> =>
    observeRequestCharges(requestId, await deps.readRequestUsage(requestId));

  return {
    decideAdmission: async ({ task, state, operationId }) => {
      const requestId = task.requestId;
      if (requestId === undefined) return undefined;
      return decideRequestSpendAdmission({
        requestId,
        taskId: task.id,
        operationId,
        policy: task.policy.config.requestBudget,
        identity: await spendIdentity(deps, requestId, task),
        observation: await observe(requestId),
        budget: requestBudgetFor(state, requestId),
        now: deps.clock(),
      });
    },
    readSpend: async (requestId) => {
      const state = await readRuntimeState(deps.runtimePath);
      return requestSpendReadout(
        requestId,
        requestBudgetFor(state, requestId),
        await observe(requestId),
      );
    },
    authorizeSpend: async (intent) => {
      const observation = await observe(intent.requestId);
      const authorized = await updateRuntimeState(deps.store, deps.runtimePath, (state) =>
        withRequestBudget(
          state,
          authorizeRequestSpend(requestBudgetFor(state, intent.requestId), intent, deps.clock()),
        ),
      );
      return requestSpendReadout(
        intent.requestId,
        requestBudgetFor(authorized, intent.requestId),
        observation,
      );
    },
    reconcileReservations: async ({ requestId, settlements }) => {
      const observation = await observe(requestId);
      await updateRuntimeState(deps.store, deps.runtimePath, (state) => {
        const budget = requestBudgetFor(state, requestId);
        if (budget === undefined) return state;
        return withRequestBudget(
          state,
          reconcileRequestBudgetReservations(budget, settlements, observation, deps.clock()),
        );
      });
    },
  };
}

async function spendIdentity(
  deps: RequestSpendGateDependencies,
  requestId: string,
  task: TaskRecord,
): Promise<RequestSpendIdentity> {
  return {
    policyDigest: policyIdentity(task.policy),
    briefRevision: await deps.readAgreementRevision(requestId),
  };
}
