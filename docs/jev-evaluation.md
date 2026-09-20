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
