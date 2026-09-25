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
`src/session/prompt-routing.ts`. It exercises the production policy directly
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
  Tandem home's diagnostics. Live runs skip `provider-failure` fixtures (`liveEligibleFixtures`):
  they script an outage for an ordinary prompt, and the real provider cannot be made to fail on
  demand, so live it would answer normally and be miscounted as a false direct route. The live
  benchmark skips the same fixtures, and scores any live direct route that has no recorded direct
  action as incorrect and unsafe, since only must-fall-back fixtures lack that recording.
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

## Baseline-vs-Jev benchmark (issue #20)

`evals/benchmark.ts` answers the question the fixture-driven harness above cannot: a Jev call is
only worth taking when it avoids more expensive work over the *whole* task, not just at the first
request. It replays the same `evals/fixtures/prompt-routing.jsonl` fixture set used by the #22
harness through two arms and reports which one reaches a verified result faster, cheaper, and at
least as correctly and safely. It reuses `evals/fixtures.ts`, `evals/run-jev.ts`'s fake and live
runners, and `evals/summarize.ts`'s percentile, aggregation, and threshold-sweep functions rather
than a second copy of any of them; it only adds what those modules do not already provide: a
control arm, a per-fixture treatment/control comparison, and a net-benefit decision rule.

### Control arm: `evals/baseline-fixtures.ts`

Classification is disabled for the control arm. The normal coordinator path is represented by one
bounded, **synthetic** recording per fixture in `evals/fixtures/baseline-recordings.jsonl`, keyed
1:1 to the matching `prompt-routing.jsonl` fixture id. These are not measured production numbers:
default CI must never call TypeSafe, Herdr, Treehouse, GitHub, or OMP, so the control arm cannot be
observed live inside `bun test`. Every recording's `description` says in plain language why its
numbers were chosen (for example, "one coordinator turn" for a single read-only lookup, "two
coordinator turns" for a request that needs a clarifying round trip). Treat every number in that
file as illustrative scaffolding for the accounting logic, not as evidence that Jev routing is
faster or cheaper in production. No speedup claim is made anywhere in this benchmark's code, tests,
or output.

Each recording carries: coordinator turns, coordinator duration, the verified correctness and
safety outcome, action failures/corrections/rework/human-intervention counts, an optional
`downstreamWorkAvoidedMs` (see accounting rules below), and an optional `directAction` outcome for
the fixtures where fake-mode replay can route directly (the six safe-direct fixtures, plus the
deliberately miscalibrated adversarial fixture that a misrouting sends directly by mistake).
Coordinator token usage is always reported `"unavailable"`, never fabricated as zero or invented as
a plausible-looking number: bounded production telemetry for the coordinator/worker path (issue
#21) is not wired into this synthetic benchmark, so no real figure exists to report.

### Treatment arm

One Jev classification (replayed through the real `classifyPrompt`/`handlePromptInput`, never
reimplemented) followed by the existing direct read-only action when policy permits, otherwise the
same recorded coordinator path the control arm uses. `evals/benchmark.ts` measures the complete
path to a verified result:

- A **successful direct route** avoids the coordinator turn entirely: total time is Jev latency
  plus a short recorded local-action duration, and the row's correctness/safety come from the
  recorded direct-action outcome, not automatically from the control arm's outcome. This is why the
  adversarial fixture matters: its recorded direct action is `incorrect`/`unsafe` even though it
  executes without error, so it is neither a coordinator-turn-avoidance win nor silently graded as
  correct just because nothing threw.
- A **failed direct route** (exercised in `tests/evals/benchmark.test.ts` by recording the
  inspect lookup's direct action as a failure) still falls back to the full
  recorded coordinator path to reach a verified result, and is counted as one action failure rather
  than a silently dropped attempt.
- A **classification fallback** pays Jev's latency and usage as overhead on top of the full
  recorded coordinator path, unless the fixture's baseline recording documents downstream work the
  fallback demonstrably avoided.

### Accounting rules

- Control and treatment always use the identical fixture prompt, task id, and recorded repository
  state; only the routing decision differs.
- **A fallback counts as pure classifier overhead unless the fixture demonstrates it avoided
  downstream work.** Concretely: `treatmentDurationMs = jevDurationMs + max(0,
  coordinatorDurationMs - downstreamWorkAvoidedMs)`. `downstreamWorkAvoidedMs` defaults to `0` (pure
  overhead, the default assumption) and is set above zero on exactly one fixture,
  `missing-task-id-inspect`, whose recording documents the rationale: Jev's precise
  `missing-explicit-task-id` reason lets the extension surface exactly what is missing immediately,
  avoiding a recorded exploratory coordinator turn that would otherwise run first.
- **Cost is never reported as zero when it is unknown.** The control arm's coordinator cost is
  always `"unavailable"`; a benchmark total cost is reported only when every priced sample in that
  total is known, so one unpriceable Jev call (a provider failure or timeout) makes the aggregate
  Jev cost `"unavailable"` too, rather than silently understating it.
- Confidence/threshold sweeps are computed by reusing `evals/summarize.ts`'s
  `sweepConfidenceThresholds` over probabilities already saved on each classification outcome; the
  benchmark makes no additional provider calls to produce them.

### Decision rule: `evals/decision.ts`

`evaluateNetBenefit` is a pure function over the aggregate: no filesystem, network, or clock access,
and it never reads or writes routing thresholds, review policy, or any other production behavior.
It reports a recommendation only. The rule is checked in this order, and each step can reject the
optimization regardless of what a later step would have shown:

1. **Safety.** Any false direct route (`routing.directRoute.falseDirectRouteCount > 0`, from the
   #22 harness's own routing-policy metric) or a drop in the verified-safe outcome rate rejects the
   optimization outright, regardless of any time or cost improvement. This is checked first because
   it is the one failure mode this benchmark exists to catch.
2. **Correctness.** A drop in the verified-correct outcome rate rejects the optimization for the
   same reason: a classifier that is faster but produces wrong results is a regression, not an
   optimization, independent of latency or price. An unavailable treatment correctness rate is
   treated as a regression against a known control rate rather than assumed acceptable.
3. **Time.** Only once safety and correctness are unregressed does latency matter. Both the p50 and
   p95 total wall-clock latency are compared, because classifier overhead that is invisible at the
   median can still make the slow tail worse.
4. **Cost.** Compared only when both arms report a known total cost; an unavailable cost is never
   treated as free, so cost comparison is skipped rather than presenting the control arm's
   `"unavailable"` coordinator cost as a $0 baseline that no treatment could ever beat honestly.
5. **Rework.** Compared last as a tie-breaking measure of whole-task cost that time and price alone
   do not capture.

`tests/evals/decision.test.ts` includes three cases required by issue #20: a faster, cheaper
treatment still **rejected** for a safety failure; a treatment **rejected** because fallback
overhead makes the whole task slower even with no safety or correctness issue; and a treatment
**accepted** because it is faster, cheaper, and at least as correct, safe, and rework-free.
Applied to the checked-in fixture set, the real recommendation is **reject**, because the
deliberately miscalibrated adversarial fixture produces exactly one false direct route; this is the
intended outcome of including that fixture, not a defect in the pilot.

### Output and live mode

`bun evals/benchmark.ts` (fake mode, the default) writes per-fixture JSONL rows plus a JSON summary
under `evals/results/baseline-benchmark/` (git-ignored), in the same shape the #22 harness uses:
one row per fixture plus one comparable aggregate summary, so two runs (or a future scenario eval)
compare directly.

A live treatment mode (`runLiveBaselineBenchmark`) exists and reuses the #22 live runner's pinned
`jev-1.13.0` model, timeout, and budget verbatim, always with a repeat count of 1 (a benchmark row
compares exactly one classification per fixture, unlike #22's routing-accuracy harness, which
repeats fixtures to measure calibration). **It has not been run.** This environment has no
`TYPESAFE_API_KEY` and none was sought out; live mode is exercised only by type-checking and by the
fake-mode tests that inject a classifier, never by an actual network call.

## Fixture-driven post-research continuation evaluation harness (issue #28)

`evals/` also holds a fixture-driven harness for the post-research continuation behavior built by
#25/#26/#27/#33/#35/#37: given a completed (or otherwise durably terminated) scout, does the
coordinator correctly stay report-only, ask one intent question, or start a focused implementation
interview, without ever authorizing implementation on its own. It exercises the production seams
directly — `classifyResearchContinuation` (`src/tasks/research-continuation-classifier.ts`) and
`decideResearchFollowUp` / `buildResearchFollowUpContent`
(`src/tasks/research-continuation.ts`, `src/session/research-follow-up.ts`) — instead of
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
  `tests/session/research-follow-up.test.ts` uses), decide the follow-up, then reopen the
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
  for the `implementation-interview` fallback (`selectedBy: "fallback"`); the `jev-low-confidence`
  fixture is built specifically below this threshold.
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
  a provider response can be unusable; every one must fall back to `implementation-interview` with
  `selectedBy: "fallback"` and an honest `fallbackReason`, never a fabricated confident answer.

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
