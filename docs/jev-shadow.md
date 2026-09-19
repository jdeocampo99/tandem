# Jev shadow integration

**Status: implemented as opt-in shadow evaluation.** There is no active Jev mode.

This document describes the shipped integration contract. Proposed context reuse and
coordinator prompt routing live in separate documents:

- [Context reuse PRD](jev-context-reuse-prd.md)
- [Coordinator prompt routing PRD](jev-prompt-routing-prd.md)
- [Evaluation plan](jev-evaluation.md)
- [Jev integration overview](jev-prd.md)

Operational instructions remain in the [README](../README.md#optional-jev-shadow-recommendations)
and [agent reference](agent-reference.md#optional-typesafe-jev-shadow-recommendations).

## Boundary

Jev supplies bounded, typed recommendations. Tandem code remains authoritative for:

- worker model and thinking configuration;
- mandatory instructions, approved scope, questions, answers, and safety constraints;
- task transitions, approvals, validation, review, delivery, and presentation state;
- endpoint, worktree, operation, reservation, and process ownership;
- prompt construction, worker launch, recovery, and cleanup.

A Jev failure, timeout, malformed response, unavailable catalogue, or missing key must
not block or alter normal worker dispatch.

## Mode and dispatch behavior

- `TANDEM_JEV_MODE` accepts `off` and `shadow`; the default is `off`.
- Shadow evaluation requires `TYPESAFE_API_KEY`; a key alone does not enable it.
- Hooks run before model-backed scout, implementer, reviewer, verifier, and presentation
  launches. The coordinator is not routed. Validation is a non-model runner and is not
  evaluated.
- Recommendations are recorded without modifying the worker job, selected model/thinking,
  prompt, supplied context, approvals, or task transitions.
- A routine notification reports the bounded result without deliberately waking another
  coordinator model turn.

## Model recommendations

Optional role-specific alternatives live in `<home>/jev.json`, normally
`~/.tandem/jev.json`, outside the repository.

- Selectors and thinking levels are checked against the OMP model catalogue.
- A model-choice question requires at least one valid alternative that differs from the
  role's pinned model/thinking pair.
- Coordinator alternatives are rejected.
- Recommendations are recorded only; they do not update model preferences or dispatch.

Automatic model switching is not implemented.

## Context recommendations

Tandem gathers candidates; Jev evaluates their relevance. Jev does not independently
search the repository or remember every conversation.

Current candidate sources are:

- completed scout reports from other tasks in the same canonical project, under their
  expected Tandem job directories;
- safe, explicit file paths in the current task's `surfaces`, resolved inside the worker's
  worktree.

The collector is deterministic and bounded: at most 12 candidates, 4,000 bytes per
excerpt, and 24,000 bytes total. The evaluator further limits the set to eight candidates
and bounds excerpts used in the request.

Selected excerpts are not currently delivered to workers. Jev relevance scores and source
references are saved as recommendations only.

## Provider, safety, and artifacts

- Provider: `https://api.typesafe.ai/v1/systemone`.
- Pinned model: `jev-1.13.0`.
- Default deadline: 2,000ms; `TANDEM_JEV_TIMEOUT_MS` accepts 1–10,000ms.
- Request and response bodies are bounded to 256 KiB each, with response validation.
- Candidate collection screens traversal, out-of-root paths, unsafe symlinks,
  binary/unreadable content, and secret-like paths. The evaluator additionally screens
  credential-like excerpt content. These filters reduce exposure; they are not a guarantee
  that arbitrary project text contains no sensitive information.
- Enabling shadow evaluation permits sending bounded task state and eligible supplemental
  excerpts to TypeSafe. Provider usage is part of the integration's cost.

Results are saved beside the job as `jev-recommendation-<job-id>.json`. Artifacts contain
bounded status, task/job identity, elapsed time, model choice/confidence when available,
context references, and provider usage. They do not store the API key, raw request, or full
excerpts.

An identity-matched existing artifact is reused on subsequent evaluation attempts. This is
local deduplication, not a transactional exactly-once guarantee across a crash during a
provider call.

Artifact statuses:

| Status | Meaning |
| --- | --- |
| `recorded` | Provider evaluation succeeded; this is not proof of useful context or savings. |
| `skipped` | No configured alternatives or eligible context justified a question. When mode is off, no artifact is created. |
| `unavailable` | Configuration, credentials, provider, or another prerequisite failed. |

## Historical verification baseline

At the implementation handoff:

- TypeScript and lint passed; the repository suite passed 276 tests.
- Focused Jev tests covered transport deadlines, configuration bounds, safe context
  collection, recommendation recording, and durable artifact reuse.
- Throwaway synthetic-provider checks exercised the worker launch path and verified that
  recommendations did not change the worker job or full prompt. Additional checks covered
  timeout and fallback behavior.
- No live TypeSafe API smoke test or end-to-end savings benchmark was completed.

These are historical results, not a claim that every future checkout has been tested.
Mocked provider success does not establish production API compatibility, selection quality,
or economic benefit.

## Implementation map

- [Environment and routing candidate configuration](../src/config/jev.ts)
- [TypeSafe transport and response validation](../src/adapters/typesafe.ts)
- [Local context candidate collection](../src/service/jev-context.ts)
- [Shadow evaluator and recommendation artifacts](../src/service/jev.ts)
- [Service composition](../src/service/controller.ts)
- [Worker dispatch integration](../src/workers/workflow.ts)
- [Presentation dispatch integration](../src/presentations/workflow.ts)
- Tests: [transport](../tests/adapters/typesafe.test.ts), [configuration](../tests/config/jev.test.ts), [context](../tests/service/jev-context.test.ts), [evaluator](../tests/service/jev.test.ts)
