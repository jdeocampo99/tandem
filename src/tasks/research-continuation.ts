import {
  DEFAULT_RESEARCH_CONTINUATION_DISPOSITION,
  MAX_CLASSIFIER_VERSION_CHARS,
  RESEARCH_CONTINUATION_DISPOSITIONS,
  RESEARCH_CONTINUATION_SCHEMA_VERSION,
  RESEARCH_CONTINUATION_SELECTORS,
  type ResearchContinuation,
  type ResearchContinuationDisposition,
  type TaskRecord,
} from "../contracts.ts";

/** A validated continuation, or the exact defect that made the candidate unusable. */
export type ResearchContinuationCheck =
  | Readonly<{ readonly valid: true; readonly continuation: ResearchContinuation }>
  | Readonly<{ readonly valid: false; readonly defect: string }>;

/** Durable state that outranks the recorded disposition when a scout report lands. */
export type ResearchContinuationOverride =
  | "not-a-scout"
  | "open-question"
  | "blocked"
  | "cancelled"
  | "incomplete"
  | "stale-generation"
  | "missing-report";

export type ResearchFollowUp =
  | ResearchContinuationDisposition
  | "answer-question"
  | "disclose-blocker";

export type ResearchFollowUpDecision = Readonly<{
  readonly followUp: ResearchFollowUp;
  readonly disposition: ResearchContinuationDisposition;
  readonly override?: ResearchContinuationOverride;
}>;

export type ResearchFollowUpInput = Readonly<{
  readonly task: Pick<
    TaskRecord,
    "kind" | "stage" | "generation" | "reportPath" | "researchContinuation" | "communication"
  >;
  /** The caller must have proven that the recorded report is readable. */
  readonly reportReadable: boolean;
  /** Generation the waking notification was bound to, when the caller knows it. */
  readonly notifiedGeneration?: number;
}>;

const CONTINUATION_KEYS = [
  "schemaVersion",
  "disposition",
  "selectedBy",
  "classifierVersion",
  "fallbackReason",
] as const;

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

/** Bounded single-line text, shared by `classifierVersion` and `fallbackReason` provenance. */
function isBoundedProvenanceText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (value.length > MAX_CLASSIFIER_VERSION_CHARS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

export function defaultResearchContinuation(): ResearchContinuation {
  return {
    schemaVersion: RESEARCH_CONTINUATION_SCHEMA_VERSION,
    disposition: DEFAULT_RESEARCH_CONTINUATION_DISPOSITION,
    selectedBy: "deterministic",
  };
}

/** Validate a candidate continuation without throwing, so each caller raises its own error type. */
export function checkResearchContinuation(value: unknown): ResearchContinuationCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, defect: "research continuation must be an object" };
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find(
    (key) => !CONTINUATION_KEYS.some((allowed) => allowed === key),
  );
  if (unexpected !== undefined) {
    return { valid: false, defect: `unexpected research continuation field ${unexpected}` };
  }
  if (record.schemaVersion !== RESEARCH_CONTINUATION_SCHEMA_VERSION) {
    return {
      valid: false,
      defect: `research continuation schemaVersion must be ${RESEARCH_CONTINUATION_SCHEMA_VERSION}`,
    };
  }
  const disposition = record.disposition;
  if (!isOneOf(disposition, RESEARCH_CONTINUATION_DISPOSITIONS)) {
    return {
      valid: false,
      defect: `unsupported research continuation disposition ${String(disposition)}`,
    };
  }
  const selectedBy = record.selectedBy;
  if (!isOneOf(selectedBy, RESEARCH_CONTINUATION_SELECTORS)) {
    return {
      valid: false,
      defect: `unsupported research continuation selector ${String(selectedBy)}`,
    };
  }
  const hasClassifierVersion = Object.hasOwn(record, "classifierVersion");
  if (hasClassifierVersion && !isBoundedProvenanceText(record.classifierVersion)) {
    return {
      valid: false,
      defect: `classifierVersion must be single-line text of at most ${MAX_CLASSIFIER_VERSION_CHARS} characters`,
    };
  }
  if (selectedBy === "explicit" && hasClassifierVersion) {
    return {
      valid: false,
      defect: "an explicitly selected research continuation carries no classifier version",
    };
  }
  if (selectedBy === "jev" && !hasClassifierVersion) {
    return {
      valid: false,
      defect: "a jev-selected research continuation requires a classifier version",
    };
  }
  const hasFallbackReason = Object.hasOwn(record, "fallbackReason");
  if (hasFallbackReason && !isBoundedProvenanceText(record.fallbackReason)) {
    return {
      valid: false,
      defect: `fallbackReason must be single-line text of at most ${MAX_CLASSIFIER_VERSION_CHARS} characters`,
    };
  }
  if (selectedBy === "fallback" && !hasFallbackReason) {
    return {
      valid: false,
      defect: "a fallback research continuation requires a fallback reason",
    };
  }
  if (selectedBy !== "fallback" && hasFallbackReason) {
    return {
      valid: false,
      defect: "only a fallback research continuation may carry a fallback reason",
    };
  }
  return {
    valid: true,
    continuation: {
      schemaVersion: RESEARCH_CONTINUATION_SCHEMA_VERSION,
      disposition,
      selectedBy,
      ...(hasClassifierVersion ? { classifierVersion: record.classifierVersion as string } : {}),
      ...(hasFallbackReason ? { fallbackReason: record.fallbackReason as string } : {}),
    },
  };
}

/** Scout records answer with their stored or defaulted continuation; other kinds have none. */
export function researchContinuationFor(
  task: Pick<TaskRecord, "kind" | "researchContinuation">,
): ResearchContinuation | undefined {
  if (task.kind !== "scout") return undefined;
  return task.researchContinuation ?? defaultResearchContinuation();
}

function overridingState(input: ResearchFollowUpInput): ResearchContinuationOverride | undefined {
  const { task } = input;
  if (task.kind !== "scout") return "not-a-scout";
  if (task.communication?.question !== undefined) return "open-question";
  if (task.stage === "blocked") return "blocked";
  if (task.stage === "cancelled") return "cancelled";
  if (task.stage !== "completed") return "incomplete";
  if (input.notifiedGeneration !== undefined && input.notifiedGeneration !== task.generation) {
    return "stale-generation";
  }
  if (task.reportPath === undefined || !input.reportReadable) return "missing-report";
  return undefined;
}

/**
 * Decide what a coordinator should do when a scout wakes it. Durable needs-decision, failed,
 * blocked, stale, and missing-report states outrank the recorded disposition; the disposition
 * itself never authorizes implementation work.
 */
export function decideResearchFollowUp(input: ResearchFollowUpInput): ResearchFollowUpDecision {
  const disposition =
    researchContinuationFor(input.task)?.disposition ?? DEFAULT_RESEARCH_CONTINUATION_DISPOSITION;
  const override = overridingState(input);
  if (override === undefined) return { followUp: disposition, disposition };
  return {
    followUp: override === "open-question" ? "answer-question" : "disclose-blocker",
    disposition,
    override,
  };
}
