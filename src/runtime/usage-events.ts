/**
 * Pure constructors that turn durable Tandem records into accounting events.
 *
 * Every event is derived from state that `state.sqlite` already holds, so the same records
 * always produce the same event identities and re-deriving them after a restart, a
 * reconciliation, or a compaction records nothing new. Nothing here reads a clock, the
 * environment, or the filesystem: the timestamps come from the records themselves.
 */

import type { IsoTimestamp, RequestBriefRecord, TaskRecord } from "../contracts.ts";
import type {
  DurableJob,
  DurableOperation,
  DurableOperationKind,
  DurableOperationPhase,
  RuntimePresentation,
  RuntimeTaskState,
} from "./schema.ts";
import {
  type ChargeMeasurement,
  chargeMicrosForTokens,
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  type RequestTerminalOutcome,
  type RequestUsageEvent,
  type RequestUsageEventKind,
  type RequestWorkIdentity,
  type RequestWorkKind,
  type RequestWorkStatus,
  requestUsageEventKey,
  type TokenMeasurement,
  type UsageRecord,
} from "./usage.ts";

/** The durable work one request's accounting pass can see for a single task. */
export type RequestWorkObservation = Readonly<{
  readonly requestId: string;
  readonly runtime: RuntimeTaskState;
  readonly presentations: readonly RuntimePresentation[];
}>;

/** One provider call's reported usage, bound to the request identity it was made under. */
export type ProviderSampleObservation = Readonly<{
  readonly requestId: string;
  readonly workKind: RequestWorkKind;
  readonly usage: UsageRecord;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  /** The provider-side request identity this sample is attributed to; re-observing it dedupes. */
  readonly sampleIdentity: string;
  readonly taskId?: string;
  readonly generation?: number;
  readonly role?: string;
}>;

/**
 * The wall-clock start of a request: the moment its brief became durable. Intake is a fact of the
 * brief record, so recording it again from a later reconciliation pass changes nothing.
 */
export function requestIntakeEvent(
  record: Pick<RequestBriefRecord, "id" | "createdAt">,
): RequestUsageEvent {
  return pointEvent({
    kind: "intake",
    workKind: "coordinator",
    identity: { requestId: record.id },
    discriminator: "brief-created",
    at: record.createdAt,
    status: "observed",
  });
}

/**
 * The wall-clock end of a request: the terminal delivery, cancellation, or failure of work done
 * under it, taken from the task update that settled it. A task that only reached `merged` records
 * nothing, because a later human merge is not the delivery moment the receipt measures to.
 */
export function requestTerminalEvent(
  requestId: string,
  task: Pick<TaskRecord, "id" | "stage" | "generation" | "updatedAt">,
): RequestUsageEvent | undefined {
  const outcome = terminalOutcomeForStage(task.stage);
  if (outcome === undefined) return undefined;
  return {
    ...pointEvent({
      kind: "terminal",
      workKind: "coordinator",
      identity: { requestId, taskId: task.id, generation: task.generation },
      discriminator: outcome,
      at: task.updatedAt,
      status: outcome === "delivered" ? "succeeded" : outcome,
    }),
    outcome,
  };
}

/**
 * One span per settled durable operation, for the task's own work and for the presentations run
 * under it. Work still in flight is left out: an operation becomes an accounting fact only once
 * its end is durable, so an in-flight worker can never inflate a total.
 */
export function settledWorkEvents(
  observation: RequestWorkObservation,
): readonly RequestUsageEvent[] {
  const { requestId, runtime, presentations } = observation;
  const taskEvents = operationSpans(requestId, allOperations(runtime), runtime.jobs);
  const presentationEvents = presentations.flatMap((presentation) =>
    operationSpans(requestId, allOperations(presentation), [presentation.job]),
  );
  return [...taskEvents, ...presentationEvents];
}

/**
 * One provider call, with whatever the provider actually reported. Tokens the provider withheld
 * stay unavailable rather than becoming zero, and a call priced without a reported token count
 * yields no charge at all rather than a charge of nothing.
 */
export function providerSampleEvent(
  observation: ProviderSampleObservation,
): RequestUsageEvent | undefined {
  const { usage } = observation;
  if (!isTimestamp(observation.startedAt) || !isTimestamp(observation.endedAt)) return undefined;
  const identity: RequestWorkIdentity = {
    requestId: observation.requestId,
    provider: usage.provider,
    model: usage.model,
    ...(observation.taskId === undefined ? {} : { taskId: observation.taskId }),
    ...(observation.generation === undefined ? {} : { generation: observation.generation }),
    ...(observation.role === undefined ? {} : { role: observation.role }),
  };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({
      kind: "provider-sample",
      identity,
      discriminator: observation.sampleIdentity,
    }),
    kind: "provider-sample",
    workKind: observation.workKind,
    identity,
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    status: providerSampleStatus(usage),
    tokens: reportedTokens(usage),
    charge: reportedCharge(usage),
    // No TypeSafe or OMP boundary publishes a subscription allowance Tandem could draw down.
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

const OPERATION_WORK_KINDS: Readonly<Record<DurableOperationKind, RequestWorkKind>> = {
  scout: "research",
  implementation: "implementation",
  fix: "implementation",
  validation: "validation",
  review: "review",
  verification: "verification",
  presentation: "presentation",
};

const SETTLED_OPERATION_STATUSES: Readonly<
  Partial<Record<DurableOperationPhase, RequestWorkStatus>>
> = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  quarantined: "quarantined",
};

const TERMINAL_STAGE_OUTCOMES: Readonly<
  Partial<Record<TaskRecord["stage"], RequestTerminalOutcome>>
> = {
  completed: "delivered",
  cancelled: "cancelled",
};

function isTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === "string" && value.trim().length > 0;
}

function terminalOutcomeForStage(stage: TaskRecord["stage"]): RequestTerminalOutcome | undefined {
  return TERMINAL_STAGE_OUTCOMES[stage];
}

function allOperations(
  source: Pick<RuntimeTaskState, "operation" | "operationHistory">,
): readonly DurableOperation[] {
  const current = source.operation === undefined ? [] : [source.operation];
  return [...(source.operationHistory ?? []), ...current];
}

function operationEnd(
  operation: DurableOperation,
  job: DurableJob | undefined,
): IsoTimestamp | undefined {
  const candidate = operation.resultConsumedAt ?? job?.consumedAt;
  return isTimestamp(candidate) ? candidate : undefined;
}

function providerSampleStatus(usage: UsageRecord): RequestWorkStatus {
  if (usage.timedOut) return "timed-out";
  return usage.inputTokens === "unavailable" && usage.outputTokens === "unavailable"
    ? "failed"
    : "succeeded";
}

function reportedTokens(usage: UsageRecord): TokenMeasurement {
  if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
    return {
      provenance: "actual",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  return {
    provenance: "unavailable",
    reason: usage.timedOut ? "provider-unavailable" : "provider-did-not-report",
  };
}

function reportedCharge(usage: UsageRecord): ChargeMeasurement {
  if (usage.pricing === "unavailable") {
    return { provenance: "unavailable", reason: "no-pricing-basis" };
  }
  const amountMicros = chargeMicrosForTokens(usage, usage.pricing);
  if (amountMicros === "unavailable") {
    return {
      provenance: "unavailable",
      reason: usage.timedOut ? "provider-unavailable" : "provider-did-not-report",
    };
  }
  return {
    provenance: "actual",
    currency: usage.pricing.currency,
    amountMicros,
    pricingSource: usage.pricing.source,
    pricingVersion: usage.pricing.schemaVersion,
  };
}

function pointEvent(
  input: Readonly<{
    readonly kind: RequestUsageEventKind;
    readonly workKind: RequestWorkKind;
    readonly identity: RequestWorkIdentity;
    readonly discriminator: string;
    readonly at: IsoTimestamp;
    readonly status: RequestWorkStatus;
  }>,
): RequestUsageEvent {
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({
      kind: input.kind,
      identity: input.identity,
      discriminator: input.discriminator,
    }),
    kind: input.kind,
    workKind: input.workKind,
    identity: input.identity,
    startedAt: input.at,
    endedAt: input.at,
    status: input.status,
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

/**
 * Child agents run interactive OMP, which reports no tokens, price, or allowance back to Tandem.
 * A work span therefore accounts for latency, identity, and outcome, and says so explicitly
 * instead of implying the work was free.
 */
function operationSpans(
  requestId: string,
  operations: readonly DurableOperation[],
  jobs: readonly DurableJob[],
): readonly RequestUsageEvent[] {
  const events: RequestUsageEvent[] = [];
  for (const operation of operations) {
    const status = SETTLED_OPERATION_STATUSES[operation.phase];
    if (status === undefined) continue;
    const job = jobs.find((candidate) => candidate.id === operation.jobId);
    const endedAt = operationEnd(operation, job);
    if (endedAt === undefined || !isTimestamp(operation.createdAt)) continue;
    const identity: RequestWorkIdentity = {
      requestId,
      taskId: operation.taskId,
      jobId: operation.jobId,
      operationId: operation.id,
      generation: operation.generation,
      role: operation.role,
      ...(job === undefined ? {} : { attempt: job.attempt }),
    };
    events.push({
      schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
      eventKey: requestUsageEventKey({
        kind: "work",
        identity,
        discriminator: `${operation.kind}:settled`,
      }),
      kind: "work",
      workKind: OPERATION_WORK_KINDS[operation.kind],
      identity,
      startedAt: operation.createdAt,
      endedAt,
      status,
      tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
      charge: { provenance: "unavailable", reason: "no-provider-boundary" },
      quota: { provenance: "unavailable", reason: "no-quota-contract" },
    });
  }
  return events;
}
