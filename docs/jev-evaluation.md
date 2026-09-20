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

## Fixture-driven post-research continuation evaluation harness (issue #28)

`evals/` also holds a fixture-driven harness for the post-research continuation behavior built by
#25/#26/#27/#33/#35/#37: given a completed (or otherwise durably terminated) scout, does the
coordinator correctly stay report-only, ask one intent question, or start a focused implementation
interview, without ever authorizing implementation on its own. It exercises the production seams
directly — `classifyResearchContinuation` (`src/tasks/research-continuation-classifier.ts`) and
`decideResearchFollowUp` / `buildResearchFollowUpContent`
(`src/tasks/research-continuation.ts`, `src/extension/research-follow-up.ts`) — instead of
reimplementing them, and reuses the prompt-routing harness's fixture-parsing shell, live-Jev
budget/cost tracking, JSONL/summary writer, and generalized percentile/usage-summary functions
rather than building a second copy of any of them.

- `evals/research-continuation-fixtures.ts`: the fixture schema and a pure loader
  (`parseResearchContinuationFixtures`) plus a filesystem loader
  (`loadResearchContinuationFixtures`), built on the same generic `parseFixtureLines` shell
  `evals/fixtures.ts` exports. A fixture records a sanitized request objective, an optional
  recorded typed Jev response or simulated provider failure code, the expected classifier
  disposition/selector/reason, the scout's durable stage to build (`scoutOutcome`: `completed`,
  `blocked`, `cancelled`, `needs-decision`, `missing-report`, or `stale-generation`), the expected
  final follow-up and override, and substrings the rendered follow-up content must and must not
  contain.
- `evals/fixtures/research-continuation.jsonl`: the versioned, sanitized, synthetic fixture set
  (`RESEARCH_CONTINUATION_FIXTURE_SET_VERSION`), covering explicit web/information research,
  explicit research-then-fix/implement requests, ambiguous ticket research resolved by an injected
  Jev response, contradictory/mixed requests, a missing API key, provider `unavailable` and
  `timeout` failures, a malformed Jev answer shape, a low-confidence Jev answer, every scout stage
  precedence outcome (`completed`, `blocked`, `cancelled` standing in for "failed" — Tandem has no
  separate failed `TaskStage` — `needs-decision`, `missing-report`, `stale-generation`), two
  restart/compaction fixtures, and one deliberately miscalibrated fixture
  (`adversarial-miscalibrated-report-only`) that proves the false-interview-rate metric actually
  detects a quality miss.
- `evals/run-research-continuation.ts`: the runner. `runFakeResearchContinuationFixtures` runs
  deterministically with no network access and no credentials inside the normal `bun test` (see
  `tests/evals/run-research-continuation.test.ts`); it derives whether Jev should be called at all
  from `classifyContinuationCues` itself, so a fixture never has to restate that prediction, and it
  injects a fixed clock (mirroring `classifyPrompt`'s clock seam) so two fake runs, including every
  nested usage-record duration, are byte-identical. Restart/compaction fixtures build a real,
  disk-backed scout through `createTaskStore`/`transitionTask` (the same pattern
  `tests/extension/research-follow-up.test.ts` uses), decide the follow-up, then reopen the
  directory with a **fresh task-store instance** and decide again, asserting byte-identical
  content. `runLiveResearchContinuationFixtures` calls the pinned Jev model for every fixture whose
  deterministic cues leave it unresolved, sharing `evals/live-jev-budget.ts`'s budget/cost tracking
  (extracted from the prompt-routing runner so there is exactly one live-Jev budget mechanism) and
  `evals/write-results.ts`'s generic JSONL/summary writer. **Live mode has not been run for this
  harness**: this repository has no `TYPESAFE_API_KEY` available in this environment, so live-mode
  wiring is covered only by an injected fake evaluator standing in for `evaluateJev`, never by an
  actual TypeSafe request. Treat it as unverified against the real model until someone with a
  pinned key runs it.
- `evals/summarize.ts`: `summarizeResearchContinuationRun` and its component functions
  (`computeResearchContinuationAccuracy`, `computeInterviewRateMetrics`,
  `computeContentInvariants`, `computeRestartConsistency`, `computeJevCallDiscipline`,
  `computeClassifierOverhead`, `computeAvoidedCoordinatorWork`, `computeSafetyFailures`) reuse the
  same generic `percentile`/`computeLatencyPercentiles`, and the provider-reliability and
  usage-summary functions generalized to accept any outcome shaped like theirs, so no metric is
  computed twice. The report separates **classifier overhead** (latency and token/cost usage only
  for fixtures that actually attempted a Jev call) from **useful avoided coordinator work**
  (fixtures that correctly stayed at `report-only`/`ask-intent` instead of opening a full
  implementation interview), and reports **safety failures on their own count, never averaged into
  the accuracy or interview-rate metrics**.

### Thresholds in force

The harness asserts against, and never overrides, the constants already pinned in
`src/tasks/research-continuation-classifier.ts`:

- `RESEARCH_CONTINUATION_CONFIDENCE_THRESHOLD` — a Jev choice below this confidence is discarded
  for the conservative `ask-intent` default; the `jev-low-confidence` fixture is built specifically
  below this threshold.
- `RESEARCH_CONTINUATION_CLASSIFIER_VERSION` (built from `RESEARCH_CONTINUATION_QUESTION_VERSION`
  and the pinned `JEV_MODEL`) — recorded as `classifierVersion` on every Jev-selected disposition;
  the harness never fabricates or bumps this version.
- `DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS` — the timeout fake-mode fixtures configure the
  classifier with.
- `MAX_CLASSIFIED_OBJECTIVE_CHARS` — the bound `sanitizeObjective` enforces before anything reaches
  Jev; fixture objectives stay well under it.

### Safety invariant

`classifyResearchContinuation` and `decideResearchFollowUp`/`buildResearchFollowUpContent` are pure
and take no task-store dependency, so no injected classifier result — however confidently
miscalibrated or however many extra fields it tries to smuggle in — can itself create, approve, or
start an implementation task. `tests/evals/research-continuation-safety.test.ts` proves this against
a deliberately adversarial injected result (full-confidence `implementation-interview` plus bogus
extra response fields): the persisted continuation carries only the four allowed fields, the
rendered content still carries its approval disclaimer, and the real lifecycle machinery
(`transitionTask`) still refuses `start` on an implementation task with no `approve` event and no
`scopeApproved`. A false implementation transition is a **safety failure**, reported and gated
separately from the accuracy metrics above; a false or missed interview is a quality miss, not a
safety failure.

### Failure examples to review before enabling broadly

These are synthetic, sanitized fixtures, not measurements of production quality. Before enabling
Jev-assisted continuation classification broadly, review at least:

- `adversarial-miscalibrated-report-only` — a confident (0.95) Jev answer of
  `implementation-interview` for a request whose ground truth is `report-only`. This is exactly the
  shape of a false interview: it costs the user an unwanted, unnecessary interview turn. The
  fixture set's `falseInterviewRate` must stay at the single expected miscalibrated case; any other
  fixture landing here is a regression.
- `scout-blocked-overrides-interview` / `scout-failed-overrides-interview` /
  `scout-needs-decision-outranks-interview` / `scout-missing-report-blocks-interview` /
  `scout-stale-generation-blocks-interview` — five ways a recorded `implementation-interview`
  disposition must never reach the user as an interview: a blocked, cancelled ("failed"),
  needs-decision, missing-report, or stale-generation scout must each disclose its own blocker (or
  answer its open question) instead. A regression here would start an interview the coordinator has
  no trustworthy report to support.
- `jev-low-confidence-ambiguous` / `jev-malformed-answer-shape` / `jev-invalid-response-ambiguous` /
  `jev-timeout-ambiguous` / `jev-unavailable-ambiguous` / `jev-not-configured-ambiguous` — six ways
  a provider response can be unusable; every one must fall back to the conservative `ask-intent`
  disposition with `selectedBy: "deterministic"`, never a fabricated confident answer.

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
