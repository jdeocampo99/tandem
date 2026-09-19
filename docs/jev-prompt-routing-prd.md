# Jev coordinator prompt-routing PRD

**Status: proposed; not implemented or authorized for activation.**

This document covers a future front-door route for coordinator prompts. Jev is a typed route
adviser, not an executor or authorization layer. The current shipped Jev behavior remains in
[Jev shadow integration](jev-shadow.md). Cross-cutting measurement belongs in the
[evaluation plan](jev-evaluation.md).

## Goal

Reduce expensive coordinator-model turns for safe operational requests while preserving the
coordinator for analysis, ambiguity, policy, and user decisions.

The route must save a complete expensive-model turn. `Jev → Luna → Sol` generally adds cost
and latency instead of reducing it.

## Recommended architecture

```text
exact-command parser
  ↓ if unmatched
one bounded Jev classification
  ↓
code-owned policy and state checks
  ↓
direct action | scout workflow | coordinator | clarification
```

1. Deterministic parsing handles exact, allowlisted commands first. Those requests bypass
   both Jev and the coordinator.
2. Unmatched natural-language prompts receive one Jev request with independent typed
   questions over the same bounded state.
3. Code combines the answers with durable task state, approval, ownership, and policy.
4. Code selects the handler or model. Jev does not generate a shell command, choose an
   arbitrary model identifier, or perform an effect.

## Minimum route facts

| Dimension | Values | Meaning |
| --- | --- | --- |
| Intent | `answer`, `research`, `act`, `steer`, `unknown` | The user's requested kind of work. |
| Target | `task`, `repository`, `conversation`, `unresolved` | What the request refers to. Code resolves the identity. |
| Effect | `read-only`, `state-change`, `sensitive`, `unknown` | A routing hint, not permission. |
| Scope | `within`, `changes`, `unclear` | Relation to the supplied approved scope. Code is authoritative. |
| Composition | `single`, `homogeneous-batch`, `mixed` | Whether the request contains one or multiple operations. |

The current Tandem adapter supports `Choice` and `Noul`. A future `Score` extension needs a
measured ranking use case. Include explicit no-match/unknown outcomes. Use Choice confidence
for route gating; do not treat it as proof of authorization or workflow correctness.

## Route policy

| Classified request | Code-owned route |
| --- | --- |
| Exact safe action | Existing typed CLI/service action |
| Research on an existing task | Resolve and validate task, then scout workflow |
| Research on a new topic | Create a bounded scout task using the original request as its objective |
| Read-only task/status query | Direct durable record/report lookup when possible |
| Answer or analysis | Normal coordinator/strong reasoning path |
| Steer an existing worker | Existing task communication path |
| Approval-bearing or sensitive action | Coordinator plus explicit user decision and runtime checks |
| Unknown, unresolved, mixed, or low-confidence request | Clarification or coordinator handling |

Examples:

- `Investigate 989` → research of an existing task; code resolves and validates `989`.
- `Investigate how to implement SSR` → research of a new topic; preserve the original
  request as the scout objective rather than asking Jev to write a prompt.
- `What are the implications of SSR?` → answer/analysis through the normal coordinator path.
- `Merge PR 989` → sensitive approval-bearing action regardless of simple wording.

## Edge cases

The route must distinguish:

- a hypothetical or quoted command from an instruction;
- pronouns, stale references, “last,” “other,” and multiple repositories;
- conditional future actions such as “after review, publish”;
- mixed batches and partial-failure behavior;
- research requests that imply network access, credentials, or side effects;
- urgent stop/cancel requests that must reach established control handling promptly;
- scope expansion and requests that contradict current approvals.

Read-only intent does not authorize unrestricted research. Reversible does not mean harmless:
publication, merge, deletion, credential access, and scope changes retain their existing gates.

## Context, cost, and caching

Send Jev the current prompt plus minimal relevant metadata, not the full coordinator transcript or
repository. Keep inferred route facts separate from observed durable state.

No server-side TypeSafe cache contract is assumed. If local classification caching is added, key
it by the normalized prompt, relevant task/conversation revision, repository identity, policy and
question versions, and pinned Jev model version. Cache classification, never authorization.

Current Tandem selects the coordinator model at process launch and does not support per-turn model
switching. Any future Luna/Sol split needs either native OMP turn-level selection or a separate
model call with explicit context transfer. Do not restart the coordinator for every prompt.

## Rollout

1. Measure the fixed-coordinator baseline.
2. Add deterministic exact-command bypass.
3. Run Jev classification in shadow mode for unmatched natural-language prompts.
4. Record Jev usage, latency, route, confidence, model handoff, cache behavior, misroutes,
   escalations, corrections, and rework.
5. Activate only allowlisted low-risk routes after total end-to-end cost and quality improve.

See the [evaluation plan](jev-evaluation.md).

## TypeSafe patterns

This proposal combines TypeSafe's [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md),
[function calling](https://docs.typesafe.ai/cookbooks/function_calling.md),
[confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md), and
[speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md) patterns.

## Open questions

- What fraction of coordinator turns are exact or safely typed operations?
- Does OMP support per-turn model selection without losing useful context?
- What context-transfer and cache behavior occurs across Luna/Sol routes?
- Which low-risk routing errors are acceptable, and which must always escalate?
- Can operational routes terminate in code, or do they still require a coordinator turn?
