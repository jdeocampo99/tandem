# Jev integration

This is the entry point for Tandem's TypeSafe Jev documentation. It records the product
goal, current status, non-negotiable boundaries, and links to the focused documents.

## Status

| Capability | Status | Document |
| --- | --- | --- |
| Opt-in shadow recommendations | Implemented; off by default | [Jev shadow integration](jev-shadow.md) |
| Supplemental context reuse | Proposed; not authorized for activation | [Context reuse PRD](jev-context-reuse-prd.md) |
| Coordinator prompt routing | Proposed; not authorized for activation | [Coordinator prompt-routing PRD](jev-prompt-routing-prd.md) |
| Experiments and rollout evidence | Measurement plan; no active behavior authorized | [Evaluation plan](jev-evaluation.md) |

Operational instructions remain in the [README](../README.md#optional-jev-shadow-recommendations)
and [agent reference](agent-reference.md#optional-typesafe-jev-shadow-recommendations).

## Product goal

Reduce the total tokens and wall-clock time required to complete a Tandem task without
worsening correctness or increasing rework.

The current product priority is useful context reuse. Automatic model switching and
coordinator prompt routing are separate proposed directions. Neither token savings nor
speed improvements have been demonstrated yet.

## System boundary

Jev supplies bounded, typed semantic judgments. Tandem code remains authoritative for:

- exact lookups, parsing, calculations, and command construction;
- task state, scope approval, permissions, ownership, and lifecycle transitions;
- validation, review, delivery, publication, merge, cancellation, and cleanup;
- worktree, endpoint, operation, reservation, and process safety;
- prompt construction, worker launch, recovery, and durable writes.

Jev must never directly authorize or perform an effect. Provider failure, timeout, malformed
output, low confidence, stale evidence, or unavailable configuration must follow an explicit
code-owned fallback.

## Current shipped behavior

The integration is opt-in shadow evaluation:

- `TANDEM_JEV_MODE` is `off` by default; `shadow` is the only enabled mode.
- Recommendations are recorded beside prepared jobs and may produce a routine notification.
- Model, prompt, context, approval, task transitions, and normal worker dispatch are unchanged.
- Jev evaluates bounded task state and eligible supplemental evidence only when enabled.
- No active model switching or active context delivery is implemented.

See [Jev shadow integration](jev-shadow.md) for the complete shipped contract and
implementation map.

## Proposed directions

### Supplemental context reuse

Tandem could gather authorized prior findings, have Jev judge relevance, and deliver a
bounded, provenance-checked supplemental handoff. Mandatory instructions, approved scope,
current questions, safety constraints, and required review findings remain unchanged.

See the [context reuse PRD](jev-context-reuse-prd.md).

### Coordinator prompt routing

A future front-door route could use deterministic parsing first, then Jev typed judgments
for unmatched natural-language prompts. Code would select a direct action, scout workflow,
normal coordinator, or clarification. Jev would not execute commands or choose authority.

See the [coordinator prompt-routing PRD](jev-prompt-routing-prd.md).

## Decision summary

- Prefer a deterministic handoff when it achieves the same result as Jev selection.
- Use Jev only when it prevents a more expensive or unnecessary model turn.
- Keep inferred route judgments separate from observed durable state.
- Cache classifications only; never cache authorization or execution decisions.
- Measure total task cost, latency, correctness, escalation, correction, and rework before
  activating either proposed direction.
- Keep active behavior explicit, reversible, and separately approved.

See the [evaluation plan](jev-evaluation.md) for baselines, metrics, experiments, and rollout
gates.

## Source of truth

For shipped behavior, source code and focused tests are authoritative. This documentation
describes the current contract and proposed work; a proposal is not authorization to
implement or enable a feature.

Current implementation areas:

- [Jev configuration](../src/config/jev.ts)
- [TypeSafe transport](../src/adapters/typesafe.ts)
- [Context candidate collection](../src/service/jev-context.ts)
- [Shadow evaluator](../src/service/jev.ts)
- [Service composition](../src/service/controller.ts)
- [Worker dispatch](../src/workers/workflow.ts)
- [Presentation dispatch](../src/presentations/workflow.ts)
