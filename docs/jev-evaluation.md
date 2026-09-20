# Jev evaluation plan

**Status: measurement plan for the active v0 prompt route and future context reuse.**

Product requirements live in the [prompt-routing PRD](jev-prompt-routing-prd.md) and
[context reuse PRD](jev-context-reuse-prd.md). The [integration overview](jev-prd.md) records
the current boundary and source map.

## Evaluation goal

A Jev change succeeds only when it lowers total input/output cost or wall-clock time at comparable
correctness and rework. A cheaper classifier call is not a win if it adds a coordinator turn,
context-transfer cost, correction cycle, or another failure.

## Baselines and experiments

Use equivalent prompt cases, fixed project state, comparable repository snapshots, and controlled
provider conditions. Repeat runs to account for model variability.

| Experiment | Purpose |
| --- | --- |
| Existing coordinator workflow without classification | Establish the control. |
| Exact-command deterministic bypass | Measure operations that avoid a model turn entirely. |
| Active v0 read-only prompt route | Measure direct lookup rate and coordinator turns avoided. |
| Jev disabled fallback on the same prompts | Isolate classifier overhead and route quality. |
| Proposed deterministic context handoff | Test whether direct reuse is sufficient without Jev. |
| Future Jev-selected context | Test whether selection saves more downstream work than it costs. |

Include no-key and provider-failure cases, exact commands, natural-language lookups, analysis,
approval-bearing actions, mixed requests, unresolved references, explicit task IDs, missing task
IDs, image-bearing prompts, and malformed provider responses.

## Metrics

Measure the whole task, not only the initial input:

- coordinator and worker input/output tokens;
- Jev input tokens, latency, provider cost, unavailable calls, and rate limits;
- task completion time to verified result;
- direct-route rate and action distribution;
- route confidence, abstentions, incorrect routes, escalations, and user corrections;
- direct action failures and normal coordinator fallback rate;
- repeated searches/file reads, failed verification, correction cycles, and human intervention;
- correctness, review findings, and rework.

Missing usage must be reported as unavailable, not counted as zero.

### Usage telemetry module

`src/runtime/usage.ts` is the single source for the bounded usage record, pricing data, cost
calculation, and cross-run aggregation used by both production route diagnostics and evaluation
artifacts:

- `UsageRecord`: provider, pinned model, input/output tokens (`number` or the literal
  `"unavailable"`, never a fabricated zero), request duration, timeout status, route/fallback
  reason, a `PricingSnapshot` or `"unavailable"`, and a schema version.
- `PricingSnapshot` / `JEV_PRICING_SNAPSHOT`: versioned, sourced, dated pricing data, kept as
  configurable data rather than a hardcoded number. Jev's published rate today is $0.042 per
  million input tokens with output free.
- `calculateUsageCost`: a pure function that takes token counts and a `PricingSnapshot` (or
  `"unavailable"`) and returns a cost estimate or `"unavailable"`. It is for reporting only and is
  never used to authorize or block work.
- `aggregateUsage`: a pure function that groups `TaggedUsageRecord` samples by fixture, role, task,
  and run, preserving an explicit `"unknown"` bucket for missing tags and counting unavailable
  token/cost samples instead of treating them as zero.

A route event on the prompt-routing path (see [prompt-routing PRD](jev-prompt-routing-prd.md))
carries its `UsageRecord` alongside the same prompt hash used to bypass and dispatch diagnostics,
so a report can join production route usage to an evaluation result without ever needing the
prompt text itself. Future evaluation and benchmark work import these same exports rather than
building a second accounting path.

## Fixture-driven routing evaluation harness

`evals/` holds a fixture-driven evaluation harness for the routing policy in
`src/extension/prompt-routing.ts`. It exercises the production policy directly
(`classifyPrompt` for classification fixtures, `handlePromptInput` for image/slash-command bypass
fixtures) instead of reimplementing it, so an evaluation result can never drift from what the
extension actually does.

- `evals/fixtures.ts`: the fixture schema and a pure loader (`parsePromptRoutingFixtures`) plus a
  filesystem loader (`loadPromptRoutingFixtures`). A fixture records a prompt, an optional explicit
  task id, either a recorded typed Jev response or a simulated provider failure code (or a bypass
  kind), the expected route (`direct` or `fallback`), the expected reason, an optional expected
  decision (per-field ground truth for `action`/`target`/`effect`/`scope`/`composition`/`taskId`),
  and a safety classification (`safe-direct`, `state-changing`, `sensitive`, `ambiguous`,
  `provider-failure`, or `bypass`).
- `evals/fixtures/prompt-routing.jsonl`: the versioned, sanitized, synthetic fixture set. Every
  fixture carries the loader's `PROMPT_ROUTING_FIXTURE_SET_VERSION`; the loader rejects a mismatch.
  It covers direct lookups, ambiguous requests, missing task ids, state-changing and sensitive
  requests, mixed requests, image/slash-command bypasses, provider failures, and one deliberately
  miscalibrated fixture that proves the false-direct-route metric actually detects a safety
  failure. Fixtures contain no real secrets or repository contents.
- `evals/run-jev.ts`: the runner. `runFakePromptRoutingFixtures` replays the fixture set
  deterministically with no network access and no credentials; it runs inside the normal `bun test`
  (see `tests/evals/run-jev.test.ts`). `runLivePromptRoutingFixtures` calls the pinned `jev-1.13.0`
  model through `evaluateJev()` with an explicit repeat count, timeout, and USD budget (reusing
  `calculateUsageCost`/`JEV_PRICING_SNAPSHOT` from `src/runtime/usage.ts`); it throws
  `LiveJevBudgetExceededError` before making any call once cumulative spend has reached the budget,
  and it is never called by `bun test`. The file's CLI entry point (`bun evals/run-jev.ts`) only
  reaches live mode behind an explicit `--live` flag plus `TYPESAFE_API_KEY`, `--repeat`,
  `--timeout`, and `--budget`; fake mode is the default. `writePromptRoutingResults` writes JSONL
  results plus a JSON summary under `evals/results/` (git-ignored), never into a production
  Tandem home's diagnostics.
- `evals/summarize.ts`: pure metric functions over `PromptRoutingRunOutcome[]` (no filesystem,
  network, or clock access): per-field classification accuracy (graded against Jev's raw answers,
  independent of routing), direct-route precision/recall with an explicit false-direct-route count
  (a safety failure) separate from a missed-direct-route count (an optimization miss), fallback
  rate and abstention recall, provider error/timeout rate, latency p50/p95 (`percentile` is a
  generic, reusable interpolated-percentile function), and a confidence-threshold sweep
  (`sweepConfidenceThresholds`) computed only from probabilities already saved on each outcome,
  never from an extra provider call. `summarizePromptRoutingRun` combines all of these into one
  report shaped identically regardless of fixture mode, so two runs (or a fake run against a live
  run) compare directly.

The harness never changes `PROMPT_ROUTING_CONFIDENCE_THRESHOLD` or any other production routing
threshold: the confidence sweep measures the saved combined-confidence score's predictive quality
in isolation, it does not re-run the full multi-field routing decision at another threshold.

Later stacked evaluation work (a baseline-vs-Jev efficiency benchmark, and deterministic scenario
evals for other subsystems) reuses this fixture loader, the runner's fake/live seams, and
`summarize.ts`'s percentile and aggregation functions rather than building parallel ones.

## Decision rules

- Deterministic exact actions are the preferred fast path.
- Direct routing is useful only when it prevents a more expensive or unnecessary coordinator turn.
- Low-confidence, mixed, unresolved, scope-changing, approval-bearing, sensitive, or destructive
  requests remain on the coordinator or explicit-user path.
- Cache classifications only when prompt, relevant state, policy, question definitions, and pinned
  Jev model are unchanged. Never cache authorization or execution decisions.
- Compare every Jev route with the simplest deterministic alternative.

## Rollout gates

The current pilot is project-wide for one configured user and requires `TYPESAFE_API_KEY`.
Before widening the allowlist or audience:

1. Complete an isolated live TypeSafe API smoke test.
2. Establish numerical direct-route correctness, fallback, latency, cost, and rework thresholds.
3. Verify provider failure, timeout, malformed output, missing task IDs, stale state, and restart
   behavior.
4. Confirm mandatory instructions, approved scope, model settings, and safety boundaries are
   unchanged.
5. Review route diagnostics for sensitive data leakage and action-result bounds.

Before any future active-context pilot, also prove candidate provenance, freshness, source scope,
supplemental budgets, and recovery behavior.

## Result record

For every experiment, record:

- date and pinned Jev/model versions;
- repository/task fixtures and relevant revisions;
- route or selection schema version;
- provider usage and latency;
- baseline and treatment outcomes;
- incorrect routes, escalations, corrections, rework, and failures;
- decision: retain, revise, defer, or reject.

If Jev does not outperform the simpler deterministic path, retain the simpler path.
