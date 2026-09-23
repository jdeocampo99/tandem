/**
 * Fixture-driven post-research continuation evaluation runner (issue #28).
 *
 * Each fixture drives two production seams in sequence, never reimplemented here:
 * 1. `classifyResearchContinuation` (`src/tasks/research-continuation-classifier.ts`) decides a
 *    disposition from a sanitized request objective, either deterministically or through an
 *    injected Jev evaluator.
 * 2. `decideResearchFollowUp` / `buildResearchFollowUpContent`
 *    (`src/tasks/research-continuation.ts`, `src/extension/research-follow-up.ts`) turn that
 *    disposition, plus the scout's durable stage, into the coordinator-facing wake content.
 *
 * Fake mode (the only mode exercised by `bun test`) never touches the network: deterministic
 * fixtures never invoke the injected evaluator at all, and ambiguous fixtures replay a recorded
 * typed Jev response or a simulated provider failure. Live mode calls the pinned `jev-1.13.0`
 * model through `evaluateJev()` with the same budget enforcement used by the prompt-routing
 * harness (`./live-jev-budget.ts`), so there is exactly one live-Jev budget mechanism in this repo.
 *
 * Usage/cost accounting reuses `src/runtime/usage.ts` and the generalized summary functions in
 * `./summarize.ts`; result writing reuses `./write-results.ts`. No second percentile, cost,
 * budget, or JSONL writer is defined here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateJev,
  JEV_MODEL,
  JEV_PROVIDER,
  JevEvaluationError,
} from "../src/adapters/typesafe.ts";
import type { ResearchContinuation, ResolvedPolicy } from "../src/contracts.ts";
import { buildResearchFollowUpContent } from "../src/extension/research-follow-up.ts";
import {
  JEV_PRICING_SNAPSHOT,
  USAGE_RECORD_SCHEMA_VERSION,
  type UsageRecord,
} from "../src/runtime/usage.ts";
import { transitionTask } from "../src/tasks/lifecycle.ts";
import {
  decideResearchFollowUp,
  type ResearchFollowUpDecision,
  type ResearchFollowUpInput,
} from "../src/tasks/research-continuation.ts";
import {
  classifyContinuationCues,
  classifyResearchContinuation,
  DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
  type JevEvaluator,
  type ResearchContinuationClassification,
  type ResearchContinuationClassifierConfig,
  type ResearchContinuationClock,
} from "../src/tasks/research-continuation-classifier.ts";
import { createTaskStore } from "../src/tasks/store.ts";
import {
  budgetGuard,
  checkLiveJevRunOptions,
  costTrackingEvaluate,
  type LiveJevBudget,
  LiveJevBudgetExceededError,
  type LiveJevRunOptions,
} from "./live-jev-budget.ts";
import {
  loadResearchContinuationFixtures,
  type ResearchContinuationFixture,
} from "./research-continuation-fixtures.ts";
import { createEphemeralHome, type EphemeralHome } from "./run-jev.ts";
import { summarizeResearchContinuationRun } from "./summarize.ts";
import type { PromptRoutingProviderOutcome, ResearchContinuationRunOutcome } from "./types.ts";
import { realEvalResultIo, writeEvalResults } from "./write-results.ts";

export type { LiveJevBudget, LiveJevRunOptions, ResearchContinuationRunOutcome };
export { LiveJevBudgetExceededError };

const FAKE_API_KEY = "fixture-key";
const NOW = "2030-01-02T03:04:05.000Z";
const IMPLEMENTATION_APPROVAL_DISCLAIMER = "approve the concrete scope before starting";

type ClassifyDeps = Readonly<{
  readonly config: ResearchContinuationClassifierConfig;
  readonly evaluate: JevEvaluator;
}>;

function fakeEvaluatorFor(fixture: ResearchContinuationFixture): JevEvaluator {
  return async () => {
    if (fixture.jevFailureCode !== undefined) {
      throw new JevEvaluationError(
        fixture.jevFailureCode,
        `fixture ${fixture.id} simulated failure`,
      );
    }
    if (fixture.jevResponse === undefined) {
      throw new Error(`fixture ${fixture.id} has no recorded jevResponse or jevFailureCode`);
    }
    return fixture.jevResponse;
  };
}

function fakeDepsFor(fixture: ResearchContinuationFixture): ClassifyDeps {
  const jevConfigured = fixture.jevConfigured ?? true;
  return {
    config: {
      timeoutMs: DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
      ...(jevConfigured ? { apiKey: FAKE_API_KEY } : {}),
    },
    evaluate: fakeEvaluatorFor(fixture),
  };
}

const PROVIDER_FAILURE_REASONS = [
  "jev-unavailable",
  "jev-invalid-response",
  "jev-invalid-request",
  "jev-error",
];

function classifierProviderOutcome(
  jevCallMade: boolean,
  reason: string,
): PromptRoutingProviderOutcome {
  if (!jevCallMade) return "not-attempted";
  if (reason === "jev-timeout") return "timeout";
  return PROVIDER_FAILURE_REASONS.includes(reason) ? "error" : "success";
}

/** Adapts the classifier's bounded `JevUsage` into the shared `UsageRecord` shape for reporting. */
function usageRecordFor(
  classification: ResearchContinuationClassification,
  jevCallMade: boolean,
): UsageRecord | undefined {
  if (!jevCallMade) return undefined;
  const shared = {
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: JEV_PROVIDER,
    model: JEV_MODEL,
    durationMs: classification.durationMs,
    reason: classification.reason,
    pricing: JEV_PRICING_SNAPSHOT,
  } as const;
  if (classification.usage === undefined) {
    return {
      ...shared,
      inputTokens: "unavailable",
      outputTokens: "unavailable",
      timedOut: classification.reason === "jev-timeout",
    };
  }
  return {
    ...shared,
    inputTokens: classification.usage.input_tokens,
    outputTokens: classification.usage.output_tokens,
    timedOut: false,
  };
}

type FollowUpTask = ResearchFollowUpInput["task"];

/** Builds the scout state `decideResearchFollowUp` should see for a fixture's `scoutOutcome`. */
function followUpTaskFor(
  fixture: ResearchContinuationFixture,
  researchContinuation: ResearchContinuation,
): FollowUpTask {
  const base = { kind: "scout" as const, researchContinuation };
  switch (fixture.scoutOutcome) {
    case "completed":
      return { ...base, stage: "completed", generation: 0, reportPath: "/reports/fixture.md" };
    case "blocked":
      return { ...base, stage: "blocked", generation: 0, reportPath: "/reports/fixture.md" };
    case "cancelled":
      return { ...base, stage: "cancelled", generation: 0, reportPath: "/reports/fixture.md" };
    case "needs-decision":
      return {
        ...base,
        stage: "completed",
        generation: 0,
        reportPath: "/reports/fixture.md",
        communication: {
          revision: 1,
          messages: [],
          question: { id: "decision-question", text: "Which fix direction should we pursue?" },
        },
      };
    case "missing-report":
      return { ...base, stage: "completed", generation: 0 };
    case "stale-generation":
      return { ...base, stage: "completed", generation: 1, reportPath: "/reports/fixture.md" };
  }
}

const FIXTURE_POLICY: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
      scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxWorkers: 3,
    maxFixRounds: 3,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

/**
 * Builds the completed scout on disk, decides its follow-up, then rebuilds it from a fresh task
 * store instance over the same directory and decides again, so a restart or compaction between
 * scout completion and coordinator follow-up is proven to reproduce identical content.
 */
async function decideRestartedFollowUp(
  fixture: ResearchContinuationFixture,
  researchContinuation: ResearchContinuation,
): Promise<
  Readonly<{ decision: ResearchFollowUpDecision; content: string; restartContent: string }>
> {
  const { home, cleanup }: EphemeralHome = await createEphemeralHome();
  try {
    const directory = join(home, "tasks");
    const reportPath = join(home, "jobs", "scout-task", "0", "job-1", "report.txt");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `Outcome: completed\n${fixture.description}\n`, "utf8");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const created = await store.create({
      id: "scout-task",
      repoPath: join(home, "repo"),
      kind: "scout",
      objective: fixture.objective,
      acceptanceCriteria: ["Report the findings"],
      surfaces: ["src"],
      policy: FIXTURE_POLICY,
      researchContinuation,
    });
    const scouting = await store.update(created.id, created.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: NOW,
      stage: "scouting",
    }));
    await store.update(scouting.id, scouting.revision, (current) =>
      transitionTask(
        current,
        { type: "scout-report-complete", generation: current.generation, reportPath },
        { now: NOW, notificationId: "scout-complete" },
      ),
    );

    const first = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const firstRecord = await first.read("scout-task");
    if (firstRecord === undefined)
      throw new Error(`fixture ${fixture.id}: scout was not persisted`);
    const decision = decideResearchFollowUp({ task: firstRecord, reportReadable: true });
    const content = buildResearchFollowUpContent(decision);

    const restarted = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const restartedRecord = await restarted.read("scout-task");
    if (restartedRecord === undefined) {
      throw new Error(`fixture ${fixture.id}: scout did not survive the simulated restart`);
    }
    const restartContent = buildResearchFollowUpContent(
      decideResearchFollowUp({ task: restartedRecord, reportReadable: true }),
    );
    return { decision, content, restartContent };
  } finally {
    await cleanup();
  }
}

function checkContent(fixture: ResearchContinuationFixture, content: string): readonly string[] {
  const failures: string[] = [];
  for (const needle of fixture.contentMustContain) {
    if (!content.includes(needle)) failures.push(`missing required text: ${needle}`);
  }
  for (const needle of fixture.contentMustNotContain) {
    if (content.includes(needle)) failures.push(`contains forbidden text: ${needle}`);
  }
  return failures;
}

/**
 * True only when an interview follow-up is rendered without carrying its own approval disclaimer.
 * A false or missed interview classification is a quality miss, tracked separately; this flags the
 * one way this pure, non-authorizing content could itself misrepresent the safety invariant.
 */
function hasSafetyFailure(decision: ResearchFollowUpDecision, content: string): boolean {
  return (
    decision.followUp === "implementation-interview" &&
    !content.includes(IMPLEMENTATION_APPROVAL_DISCLAIMER)
  );
}

async function runResearchContinuationFixture(
  fixture: ResearchContinuationFixture,
  mode: "fake" | "live",
  runIndex: number,
  deps: ClassifyDeps,
  now: ResearchContinuationClock,
): Promise<ResearchContinuationRunOutcome> {
  let jevCallMade = false;
  const wrapped: JevEvaluator = async (input, options) => {
    jevCallMade = true;
    return deps.evaluate(input, options);
  };
  const classification = await classifyResearchContinuation(
    { objective: fixture.objective, taskKind: "scout" },
    deps.config,
    wrapped,
    now,
  );
  const jevCallExpected =
    !classifyContinuationCues(fixture.objective).resolved && deps.config.apiKey !== undefined;
  const providerOutcome = classifierProviderOutcome(jevCallMade, classification.reason);
  const usage = usageRecordFor(classification, jevCallMade);
  const continuation = classification.continuation;

  const { decision, content, restartContent } =
    fixture.restartCheck === true
      ? await decideRestartedFollowUp(fixture, continuation)
      : {
          ...(() => {
            const task = followUpTaskFor(fixture, continuation);
            const notifiedGeneration = fixture.scoutOutcome === "stale-generation" ? 0 : undefined;
            const built = decideResearchFollowUp({
              task,
              reportReadable: true,
              ...(notifiedGeneration === undefined ? {} : { notifiedGeneration }),
            });
            return { decision: built, content: buildResearchFollowUpContent(built) };
          })(),
          restartContent: undefined,
        };

  const contentFailures = [
    ...checkContent(fixture, content),
    ...(restartContent !== undefined && restartContent !== content
      ? ["restart content diverged from the original decision"]
      : []),
  ];

  return {
    fixtureId: fixture.id,
    fixtureSetVersion: fixture.fixtureSetVersion,
    mode,
    runIndex,
    scenario: fixture.scenario,
    scoutOutcome: fixture.scoutOutcome,
    expectedDisposition: fixture.expectedDisposition,
    actualDisposition: continuation.disposition,
    expectedSelectedBy: fixture.expectedSelectedBy,
    actualSelectedBy: continuation.selectedBy,
    classifierReason: classification.reason,
    providerOutcome,
    jevCallExpected,
    jevCallMade,
    expectedFollowUp: fixture.expectedFollowUp,
    actualFollowUp: decision.followUp,
    ...(fixture.expectedOverride === undefined
      ? {}
      : { expectedOverride: fixture.expectedOverride }),
    ...(decision.override === undefined ? {} : { actualOverride: decision.override }),
    content,
    ...(restartContent === undefined ? {} : { restartContent }),
    contentFailures,
    safetyFailure: hasSafetyFailure(decision, content),
    durationMs: classification.durationMs,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Fake mode: deterministic, no network, safe for `bun test`. Uses a fixed clock rather than the
 * real one, since fake mode never makes a real provider call and so has no real latency to
 * measure: every duration (the outcome's own and its nested usage record's) is therefore always
 * zero, and two fake runs over the same fixtures are byte-identical.
 */
export async function runFakeResearchContinuationFixtures(
  fixtures: readonly ResearchContinuationFixture[],
): Promise<readonly ResearchContinuationRunOutcome[]> {
  const now: ResearchContinuationClock = () => 0;
  const outcomes: ResearchContinuationRunOutcome[] = [];
  for (const fixture of fixtures) {
    outcomes.push(
      await runResearchContinuationFixture(fixture, "fake", 0, fakeDepsFor(fixture), now),
    );
  }
  return outcomes;
}

/**
 * Live mode: calls the pinned `jev-1.13.0` model through `evaluateJev()` for every fixture whose
 * deterministic cues leave it unresolved, sharing the exact budget/cost tracking the
 * prompt-routing harness uses (`./live-jev-budget.ts`). Opt-in only: never called by `bun test`.
 */
export async function runLiveResearchContinuationFixtures(
  fixtures: readonly ResearchContinuationFixture[],
  options: LiveJevRunOptions,
): Promise<readonly ResearchContinuationRunOutcome[]> {
  checkLiveJevRunOptions(options);
  const spentTracker = { totalUsd: 0 };
  const pricing = options.budget.pricing ?? JEV_PRICING_SNAPSHOT;
  const evaluate = costTrackingEvaluate(options.evaluate ?? evaluateJev, pricing, spentTracker);
  const guard = budgetGuard(spentTracker, options.budget);
  const deps: ClassifyDeps = {
    config: { apiKey: options.apiKey, timeoutMs: options.timeoutMs },
    evaluate,
  };
  const now: ResearchContinuationClock = () => performance.now();
  const outcomes: ResearchContinuationRunOutcome[] = [];
  for (const fixture of fixtures) {
    for (let runIndex = 0; runIndex < options.repeatCount; runIndex += 1) {
      if (!classifyContinuationCues(fixture.objective).resolved) guard();
      outcomes.push(await runResearchContinuationFixture(fixture, "live", runIndex, deps, now));
    }
  }
  return outcomes;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/research-continuation.jsonl", import.meta.url),
);
const DEFAULT_OUTPUT_DIR = fileURLToPath(
  new URL("./results-research-continuation", import.meta.url),
);

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const io = await realEvalResultIo();
  if (!args.includes("--live")) {
    const outcomes = await runFakeResearchContinuationFixtures(fixtures);
    const { resultsPath, summaryPath } = await writeEvalResults(
      outcomes,
      DEFAULT_OUTPUT_DIR,
      io,
      summarizeResearchContinuationRun,
    );
    console.log(`fake mode: wrote ${resultsPath} and ${summaryPath}`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("--live requires TYPESAFE_API_KEY to be set");
  }
  const repeatCount = Number(readFlag(args, "--repeat") ?? "");
  const timeoutMs = Number(readFlag(args, "--timeout") ?? "");
  const maxTotalCostUsd = Number(readFlag(args, "--budget") ?? "");
  if (
    !Number.isFinite(repeatCount) ||
    !Number.isFinite(timeoutMs) ||
    !Number.isFinite(maxTotalCostUsd)
  ) {
    throw new Error("--live requires --repeat, --timeout, and --budget to all be numbers");
  }
  const outcomes = await runLiveResearchContinuationFixtures(fixtures, {
    apiKey,
    timeoutMs,
    repeatCount,
    budget: { maxTotalCostUsd },
  });
  const { resultsPath, summaryPath } = await writeEvalResults(
    outcomes,
    DEFAULT_OUTPUT_DIR,
    io,
    summarizeResearchContinuationRun,
  );
  console.log(`live mode: wrote ${resultsPath} and ${summaryPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
