# Jev evaluation plan

**Status: measurement plan; no active behavior is authorized by this document.**

This document holds cross-cutting experiments and evidence for Jev features. Product
requirements live in the [context reuse PRD](jev-context-reuse-prd.md) and
[coordinator prompt-routing PRD](jev-prompt-routing-prd.md). The shipped contract lives in
[Jev shadow integration](jev-shadow.md).

## Evaluation goal

A Jev change succeeds only when it lowers total input/output cost or wall-clock time at
comparable correctness and rework. A cheaper individual model turn is not a win if it adds a
Jev call, context-transfer cost, correction cycle, or another coordinator turn.

## Baselines and experiments

Use equivalent task cases, fixed role models/thinking, comparable repository snapshots, and
controlled cache conditions. Repeat runs to account for model variability.

| Experiment | Purpose |
| --- | --- |
| Existing workflow, Jev off | Establish the control. |
| Exact-command deterministic bypass | Measure operations that avoid a model turn entirely. |
| Bounded deterministic context handoff | Test whether direct reuse is sufficient without Jev. |
| Current Jev shadow evaluation | Measure live API behavior, selector quality, provider cost, and overhead without changing behavior. |
| Proposed Jev-selected context | Test whether selection saves more downstream work than it costs. |
| Prompt-routing shadow | Compare Jev route suggestions to actual coordinator handling without changing the route. |
| Prompt-routing pilot | Test only allowlisted low-risk routes after shadow evidence supports activation. |

Include cases with no prior findings, one obvious useful finding, competing findings, unrelated
findings, stale/conflicting evidence, exact commands, natural-language operations, analysis,
approval-bearing actions, mixed requests, and unresolved references.

## Metrics

Measure the whole task, not only the initial worker prompt:

- coordinator and worker input/output tokens;
- Jev input tokens, latency, provider cost, unavailable calls, and rate limits;
- cached input separately when the provider reports it;
- model context-transfer and session-start overhead;
- task completion time to verified result;
- direct-bypass rate and route distribution;
- route confidence, abstentions, misroutes, escalations, and user corrections;
- repeated searches/file reads, failed verification, correction cycles, and human intervention;
- correctness, review findings, and rework.

Missing usage must be reported as unavailable, not counted as zero.

## Decision rules

- Deterministic exact actions are the preferred fast path.
- Jev is useful only when its classification prevents a more expensive or unnecessary model
  turn.
- Low-confidence, mixed, unresolved, scope-changing, approval-bearing, sensitive, or
  destructive requests remain on the coordinator/explicit-user path.
- Cache classifications only when the prompt, relevant state, policy, question definitions,
  and pinned Jev model are unchanged. Never cache authorization or execution decisions.
- Do not assume provider cache reuse across models or sessions; record actual cache data when
  available.
- Compare every Jev proposal with the simplest deterministic alternative.

## Rollout gates

Before any active context pilot:

1. Complete an isolated live TypeSafe API smoke test.
2. Establish numerical quality, latency, cost, and rework thresholds.
3. Verify provider failure, timeout, malformed output, empty candidates, stale evidence,
   conflicting evidence, duplicate sources, and restart/resume behavior.
4. Confirm mandatory instructions, approved scope, model settings, and safety boundaries are
   unchanged.
5. Obtain explicit approval for activation.

Before wider enablement, report workload mix, sample size, usage completeness, cache conditions,
variability, measured regressions, and comparison against deterministic behavior.

## Result record

For every experiment, record:

- date and pinned Jev/model versions;
- repository/task fixture and relevant revisions;
- route or selection schema version;
- provider usage, latency, and cache observations;
- baseline and treatment outcomes;
- misroutes, escalations, corrections, rework, and failures;
- decision: retain, revise, defer, or reject.

If Jev does not outperform the simpler deterministic path, retain the simpler path.
