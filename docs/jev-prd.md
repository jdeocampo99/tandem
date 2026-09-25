# Jev integration

This is the entry point for Tandem's TypeSafe Jev documentation. It records the product goal,
current status, non-negotiable boundaries, and links to the focused documents.

## Status

| Capability | Status | Document |
| --- | --- | --- |
| TypeSafe Jev transport | Retained; bounded and typed | [adapter](../src/adapters/typesafe.ts) |
| Coordinator prompt routing | v0 active when `TYPESAFE_API_KEY` is present | [prompt-routing PRD](jev-prompt-routing-prd.md) |
| Supplemental context reuse | Proposed; not active | [context reuse PRD](jev-context-reuse-prd.md) |
| Experiments and rollout evidence | Measurement plan for routing and future context reuse | [evaluation plan](jev-evaluation.md) |

Operational instructions live in the [README](../README.md#jev-integration-and-prompt-routing)
and [policy reference](reference/policy.md#jev-prompt-routing).

## Product goal

Reduce unnecessary coordinator-model turns for safe, read-only Tandem lookups without worsening
correctness, hiding ambiguity, or weakening approval and ownership boundaries.

The v0 route is intentionally narrower than general intent routing. It optimizes existing
deterministic service actions; it does not select models, create work, research topics, or mutate
state.

## System boundary

Jev supplies bounded, typed semantic judgments. Tandem code remains authoritative for:

- exact lookups, parsing, calculations, and action construction;
- task identity, state, scope, ownership, permissions, and approvals;
- validation, review, delivery, publication, merge, cancellation, and cleanup;
- worktree, endpoint, operation, reservation, and process safety;
- prompt construction, worker launch, recovery, and durable writes.

Jev must never directly authorize or perform an effect. Provider failure, timeout, malformed
output, low confidence, stale information, or unavailable configuration follows a code-owned
fallback.

## Current shipped behavior

The extension intercepts interactive prompts before the coordinator turn:

1. Slash commands and prompts with images bypass classification.
2. Unmatched text is normalized and sent once to Jev with the prompt, any explicit task ID, and
   the fixed supported-lookup list. The full transcript and repository contents are not sent.
3. Jev answers independent typed questions for action, target, effect, scope, and composition.
4. Code requires complete answers, confidence of at least `0.80`, a single operation, in-scope
   read-only effect, and an explicit task ID for task-specific actions.
5. Allowlisted direct actions are `list`, `presentations`, `show`, `messages`, `inspect`, and
   `recovery-plan`. They call the existing `TandemService` and display a bounded result.
6. A short reply while Tandem waits on a fixed-choice answer (recovery restart, validation retry,
   "Keep fixing?", or brief approval) is mapped by Jev to one code-listed choice. Code answers
   low-risk choices directly and asks an exact `y` before approving a brief.
7. Every other case returns `undefined` so the normal coordinator handles the original prompt.

Route events are append-only diagnostics at `<home>/logs/tandem.jsonl`. They record a short prompt
hash, bounded route facts, reason, confidence, and latency; raw prompts and API keys are excluded.
The provider model is pinned to Jev `1.13.0`, with a default 1,500ms timeout configurable through
`TANDEM_JEV_TIMEOUT_MS` within 100–10,000ms.

## Proposed direction: supplemental context reuse

Tandem may later gather authorized prior findings, have Jev judge relevance among those candidates,
and deliver a bounded, provenance-checked supplemental handoff. Mandatory instructions, approved
scope, current questions, safety constraints, and required review findings remain unchanged.

See the [context reuse PRD](jev-context-reuse-prd.md).

## Decision summary

- Prefer a deterministic service action when it achieves the requested result.
- Route only the fixed allowlist of read-only lookups in v0.
- Keep inferred route judgments separate from observed durable state.
- Treat low confidence, ambiguity, state change, sensitivity, and provider failure as coordinator
  inputs.
- Cache classifications only if a future implementation proves state and policy keys stable;
  never cache authorization or execution decisions.
- Measure total cost, latency, correctness, escalation, correction, and rework before widening
  the route.

See the [evaluation plan](jev-evaluation.md) for baselines, metrics, and rollout gates.

## Source of truth

Source code and focused tests are authoritative. This documentation describes the current v0
contract and proposed work; the proposed context-reuse path is not implemented or enabled.

Current implementation areas:

- [TypeSafe transport](../src/adapters/typesafe.ts)
- [Prompt routing](../src/session/prompt-routing.ts)
- [Extension registration](../src/extension/registration.ts)
- [Diagnostic persistence](../src/runtime/diagnostics.ts)
