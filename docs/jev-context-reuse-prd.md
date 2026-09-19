# Jev supplemental-context reuse PRD

**Status: proposed; not implemented or authorized for activation.**

This document covers selecting useful prior evidence for a worker. The shipped
recommendation-only behavior is documented in [Jev shadow integration](jev-shadow.md).
Cross-cutting measurement belongs in the [evaluation plan](jev-evaluation.md).

## Product goal

Reduce the total tokens and wall-clock time required to complete a Tandem task without
worsening correctness or increasing rework.

The target is useful context reuse, not automatic model switching. A simpler deterministic
handoff is preferable when it achieves comparable results with less overhead.

## Proposed workflow

1. Tandem deterministically gathers eligible findings for a prepared worker.
2. Each candidate receives a stable identity, authorized source, repository identity,
   relevant revision or content identity, and bounded excerpt.
3. Jev evaluates relevance among the supplied candidates. It does not search the repository,
   remember conversations, establish freshness, or grant authority.
4. Code verifies freshness, provenance, path scope, duplicate identity, and the supplemental
   byte/token budget.
5. The worker receives only the selected supplemental evidence, with source references and
   an explicit boundary that it is untrusted task data rather than new instructions.
6. The prepared-job context is frozen through launch and recovery.

The worker's configured model, mandatory instructions, approved scope, current questions and
answers, safety boundaries, and required review findings remain unchanged.

## Working scenario

A user asks Tandem to add an invite-member flow. Earlier same-project scouts investigated
authentication, organization membership, and billing.

A useful handoff selects authentication and membership findings, includes billing only when
relevant, and keeps the worker responsible for checking current code. The benefit comes from
avoided repeated investigation, not from adding unrestricted prompt text.

## Existing candidate limitations

Current candidate collection is bounded and deterministic:

- completed scout reports from the same canonical project;
- safe explicit files from the receiving task's `surfaces`.

Known limitations:

- no general conversation-memory index or repository-wide semantic retrieval;
- collection order is not relevance-based retrieval;
- useful material may be excluded before Jev sees it;
- saved reports are not yet validated against current code freshness;
- selected excerpts are not currently delivered to workers;
- existing mandatory worker context is not removed or shortened.

## Proposed requirements

| ID | Requirement |
| --- | --- |
| C1 | Keep configured role models and thinking levels unchanged. Do not turn model recommendations into automatic routing. |
| C2 | Apply selection only to supplemental evidence. Never remove mandatory instructions, approved scope, current questions/answers, safety constraints, or required review findings. |
| C3 | Use a strict supplemental token budget, source references, and duplicate suppression. Determine the budget through measurement. |
| C4 | Resolve evidence from authorized local sources. Treat it as untrusted task data, not authority to expand scope. Preserve provider opt-in and secret/path screening. |
| C5 | Define freshness and provenance checks before reuse: source task/report, repository identity, relevant revision or file identity, and receiving-worker applicability. |
| C6 | Record what was delivered, source identities, budget usage, selection mode, and bypass/fallback reason. Avoid keys and unnecessary sensitive content. |
| C7 | Use a bounded timeout and explicit fallback. Jev failure must not block progress or remove baseline context. |
| C8 | Keep prepared-job context stable through launch and recovery. Do not repeatedly append evidence or reuse a decision for the wrong source revision. |
| C9 | Keep enablement explicit and reversible for future jobs. Do not silently mutate running workers, model preferences, or the active server session. |

## Evaluation gates

Use the [evaluation plan](jev-evaluation.md) before active delivery. Compare:

- Jev off, existing workflow;
- bounded deterministic handoff without Jev;
- current Jev shadow evaluation;
- Jev-selected supplemental handoff.

Include tasks with no prior findings, one obvious useful report, competing reports, unrelated
findings, stale evidence, and conflicting evidence. Do not call Jev merely to select the only
obvious handoff when deterministic code is sufficient.

Before an active-context pilot:

1. Complete an isolated live API smoke test and measure overhead and fallback behavior.
2. Establish a repeatable baseline and numerical quality, latency, and cost thresholds.
3. Demonstrate that selected bounded evidence reaches the worker while required instructions
   and its configured model remain unchanged.
4. Exercise stale/conflicting context, duplicates, provider failure, empty candidates, and
   restart/resume behavior.
5. Confirm that gathering and delivery obey project, worktree, and sensitive-data boundaries.

If Jev does not outperform simpler context reuse, retain the simpler approach.

## Open questions

- Which handoffs already prevent repeated investigation?
- What metadata produces useful candidate sets before invoking Jev?
- When is there enough candidate competition to justify a provider call?
- Should workers receive excerpts, summaries, references, or a combination?
- How should stale findings be invalidated across worktrees, revisions, and resumed jobs?
- Can results be reused safely across equivalent requests without stale-context errors?
- What supplemental budget and selection threshold work for each role and task class?
- What privacy controls, retention policy, and visibility does external evaluation require?
