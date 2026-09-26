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
  USD_MICROS_PER_DOLLAR,
  type UsageRecord,
} from "./usage.ts";
import { MAX_USAGE_LABEL_CHARS } from "./usage-codec.ts";

/**
 * The durable work one accounting pass can see for a single task, under the request that governs
 * it or, without one, under the task's own ledger scope.
 */
export type RequestWorkObservation = Readonly<{
  readonly requestId: string | undefined;
  readonly runtime: RuntimeTaskState;
  readonly presentations: readonly RuntimePresentation[];
  /** Token tallies the task's workers recorded, by job id; a job without one stays unmeasured. */
  readonly tallies?: ReadonlyMap<string, JobTokenTally>;
}>;

/** The tokens one job's model replies reported, and OMP's price-table estimate of their cost. */
export type JobTokenTally = Readonly<{
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
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
 * The wall-clock end of a request: a scout's finished research, an implementation reaching ready
 * (or a published pull request), or a cancellation, stamped at the task update that showed it.
 * Implementation work never reaches `completed`, so its delivery is the ready handoff; the event is
 * keyed without a time, so a later publish or human merge re-derives the same event and cannot move
 * the delivery moment.
 */
export function requestTerminalEvent(
  requestId: string,
  task: Pick<TaskRecord, "id" | "stage" | "generation" | "updatedAt" | "pullRequest">,
): RequestUsageEvent | undefined {
  const published = task.pullRequest?.state === "open" || task.pullRequest?.state === "merged";
  const outcome = published ? "delivered" : terminalOutcomeForStage(task.stage);
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
  const tallies = observation.tallies ?? new Map<string, JobTokenTally>();
  const taskEvents = operationSpans(requestId, allOperations(runtime), runtime.jobs, tallies);
  const presentationEvents = presentations.flatMap((presentation) =>
    operationSpans(
      requestId,
      allOperations(presentation),
      presentation.job === undefined ? [] : [presentation.job],
      tallies,
    ),
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

// ponytail: "verification" stays mapped so a legacy operation still classifies; see
// DurableOperationKind.
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
  ready: "delivered",
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
 * Child agents run interactive OMP. A worker that tallied its model replies' reported tokens
 * carries them as actual tokens, with OMP's price-table cost as an estimate; one that did not,
 * such as a model-free validation run, says so explicitly instead of implying the work was free.
 */
function operationSpans(
  requestId: string | undefined,
  operations: readonly DurableOperation[],
  jobs: readonly DurableJob[],
  tallies: ReadonlyMap<string, JobTokenTally>,
): readonly RequestUsageEvent[] {
  const events: RequestUsageEvent[] = [];
  for (const operation of operations) {
    const status = SETTLED_OPERATION_STATUSES[operation.phase];
    if (status === undefined) continue;
    const job = jobs.find((candidate) => candidate.id === operation.jobId);
    const endedAt = operationEnd(operation, job);
    if (endedAt === undefined || !isTimestamp(operation.createdAt)) continue;
    const keyed: RequestWorkIdentity = {
      ...(requestId === undefined ? {} : { requestId }),
      taskId: operation.taskId,
      jobId: operation.jobId,
      operationId: operation.id,
      generation: operation.generation,
      role: operation.role,
      ...(job === undefined ? {} : { attempt: job.attempt }),
    };
    events.push({
      schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
      // The operation alone identifies its span; the model describes it. Keying without the model
      // keeps a span recorded before the model was attributed from being counted a second time.
      eventKey: requestUsageEventKey({
        kind: "work",
        identity: keyed,
        discriminator: `${operation.kind}:settled`,
      }),
      kind: "work",
      workKind: OPERATION_WORK_KINDS[operation.kind],
      identity: { ...keyed, ...routedModel(operation) },
      startedAt: operation.createdAt,
      endedAt,
      status,
      ...measuredUsage(tallies.get(operation.jobId)),
      quota: { provenance: "unavailable", reason: "no-quota-contract" },
    });
  }
  return events;
}

/**
 * The provider and exact model the operation was admitted to run, from the routing transition
 * recorded on it at admission. Validation is admitted without one because it runs no model, and a
 * legacy operation without one stays unattributed rather than having a model inferred for it.
 */
function routedModel(operation: DurableOperation): Pick<RequestWorkIdentity, "provider" | "model"> {
  const routing = operation.routing;
  if (routing === undefined) return {};
  return {
    ...(fitsLabel(routing.provider) ? { provider: routing.provider } : {}),
    ...(fitsLabel(routing.selector) ? { model: routing.selector } : {}),
  };
}

/** Whether a value can be stored as an accounting label, so one long name never fails a record. */
function fitsLabel(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_USAGE_LABEL_CHARS;
}

function measuredUsage(
  tally: JobTokenTally | undefined,
): Pick<RequestUsageEvent, "tokens" | "charge"> {
  if (tally === undefined) {
    return {
      tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
      charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    };
  }
  return {
    tokens: {
      provenance: "actual",
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
    },
    charge: {
      provenance: "estimated",
      currency: "USD",
      amountMicros: Math.round(tally.costUsd * USD_MICROS_PER_DOLLAR),
      pricingSource: "omp-model-price-table",
      pricingVersion: 1,
    },
  };
}
