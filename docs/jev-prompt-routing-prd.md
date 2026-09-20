# Jev coordinator prompt-routing PRD

**Status: v0 implemented for one-user, project-wide pilot when `TYPESAFE_API_KEY` is present.**

Jev is a bounded typed classifier at the coordinator input boundary, not an executor,
authorization layer, or model selector. The route optimizes fixed read-only Tandem service actions;
all other prompts remain coordinator input.

## Goal

Avoid a full coordinator-model turn for safe operational lookups while preserving the coordinator
for analysis, ambiguity, policy, research, communication, and user decisions.

The route must save a complete expensive turn. A Jev call that still requires a coordinator turn is
not a successful direct route.

## Implemented insertion points

```text
interactive OMP input
  ↓
extension input handler
  ├─ exact slash command or image → normal OMP handling
  └─ unmatched text
       ↓
     one bounded Jev classification
       ↓
     code-owned route policy
       ├─ direct TandemService read-only action
       └─ undefined → normal coordinator handling
```

The implementation lives at:

- `src/extension/prompt-routing.ts`: normalization, Jev questions, confidence gate, allowlist,
  action construction, result display, and diagnostics;
- `src/extension/registration.ts`: OMP `input` hook;
- `src/extension.ts`: process-boundary configuration and service/home dependencies;
- `src/adapters/typesafe.ts`: pinned transport, request validation, timeout, and response validation;
- `src/runtime/diagnostics.ts`: append-only local route events.

Routing does not run in workers, presentation dispatch, task creation, approval, or lifecycle
transitions. Those layers remain deterministic and unchanged.

## Typed route facts

Jev answers five independent choice questions over the normalized prompt:

| Dimension | Values | Meaning |
| --- | --- | --- |
| Action | `list`, `presentations`, `show`, `messages`, `inspect`, `recovery-plan`, `none` | One fixed lookup or no match. |
| Target | `repository`, `task`, `conversation`, `unresolved` | What the request refers to. |
| Effect | `read-only`, `state-change`, `sensitive`, `unknown` | Routing classification, never permission. |
| Scope | `within`, `changes`, `unclear` | Relation to this Tandem repository. |
| Composition | `single`, `homogeneous-batch`, `mixed` | Whether one lookup is requested. |

Jev receives only the prompt, an explicit task ID if present, and the supported lookup list. It
does not receive the full transcript, repository contents, API keys, or arbitrary command text.
Jev cannot invent a task identifier; task-specific direct actions require a literal `task-...`
identifier or UUID extracted from the prompt.

## Route policy

| Classified request | Code-owned route |
| --- | --- |
| `list` or `presentations`, repository target | Direct service lookup |
| `show`, `messages`, `inspect`, or `recovery-plan` with explicit task ID | Direct service lookup |
| Missing facts, unknown target, or `none` | Normal coordinator |
| Confidence below `0.80` | Normal coordinator |
| State-changing, sensitive, unclear-scope, or mixed request | Normal coordinator |
| Provider timeout, unavailable response, or malformed output | Normal coordinator |
| Image-bearing input or slash command | Existing OMP handling |

Direct actions use existing `executeTandemAction` and the current service. They do not bypass
service state checks; they do not require approval because this allowlist is read-only. Results are
bounded before display. A failed direct action is displayed as an error and is still handled as a
route attempt; it never becomes an authorization fallback.

## Confidence and bounded cost

- Jev model: `jev-1.13.0`.
- Default timeout: 1,500ms.
- Accepted timeout configuration: 100–10,000ms through `TANDEM_JEV_TIMEOUT_MS`.
- Direct-route threshold: minimum of each selected-choice probability and confidence is at least
  `0.80`.
- Prompt limit before provider invocation: 16,000 characters after whitespace normalization.
- One provider request per unmatched prompt; no retry loop.
- No classification cache in v0. A future cache must include normalized prompt, relevant durable
  revision, repository identity, policy version, question version, and Jev model; never cache
  authorization or execution decisions.

## Safety and fallback

The provider is optional. `TYPESAFE_API_KEY` enables classification; missing keys return the
original prompt to normal coordinator handling. Invalid configuration, timeout, unavailable
provider, invalid response, incomplete answers, low confidence, task ambiguity, mixed requests,
scope changes, and all effects other than read-only use the same fallback.

The classifier's effect answer is only a route fact. Code does not infer approval from it. Exact
task identity, ownership, current state, and action behavior remain service responsibilities.

## Observability

Events append to `<home>/logs/tandem.jsonl`:

- `prompt-route-bypassed`: known command or attachments;
- `prompt-route-evaluated`: classifier, bounded reason, latency, prompt hash, route facts, and a
  bounded usage record when a Jev request was attempted;
- `prompt-route-fallback`: why no direct route was selected;
- `prompt-route-dispatched`: selected action and optional explicit task ID;
- `prompt-route-failed`: direct action failed, without persisting the error text.

The prompt hash is a short SHA-256 prefix. Raw prompts, API keys, full provider payloads, and
full action errors are not recorded. Diagnostic failure never changes prompt handling.

The usage record on `prompt-route-evaluated` (see [`src/runtime/usage.ts`](../src/runtime/usage.ts))
carries the provider, pinned model, input/output tokens or an explicit `unavailable` marker,
request duration, timeout status, the route reason, and a pricing snapshot or `unavailable`. It is
schema-versioned and never fabricates a token count or price. Any diagnostic reader can join a
route event to an evaluation result through the shared prompt hash without ever seeing the prompt
itself. Cost figures derived from this record are informational only and never authorize or block
work.

## Pilot and evaluation

The v0 pilot is project-wide for one configured user and is enabled by the API key rather than a
second mode flag. Existing slash commands and all non-allowlisted natural language remain on
their established paths.

Evaluate direct-route rate, Jev latency and cost, coordinator-turn avoidance, confidence and
abstention, incorrect routes, action failures, user corrections, and total task rework. Compare
against the same prompts with classification disabled. Widen the allowlist only when direct
lookup correctness, fallback behavior, end-to-end cost, and latency are measured.

## TypeSafe patterns

The implementation uses TypeSafe's [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)
and [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md) patterns.
Function calling is unnecessary because code constructs the fixed action after classification.

## Future directions

- route a bounded scout request only after a separate policy and task-creation design;
- support clarification as an explicit coordinator path rather than a direct action;
- add state-aware caching only after durable revision keys are defined;
- measure per-turn model selection only if OMP supplies a safe, native boundary.
