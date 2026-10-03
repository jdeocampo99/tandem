# Harnesses

Which agent program runs each of Tandem's agents, how Tandem derives and records it, and the launch
port every harness implements.

Code: src/harness/contract.ts (`HarnessName`, `harnessOf`, the `Harness` launch port), src/harness/resolve.ts
(`harnessFor`, `harnessForRole`), src/harness/claude-code/models.ts (the Claude Code catalogue),
src/harness/omp/launch.ts, src/coordinator/record.ts, src/workers/jobs.ts.
Tests: tests/harness/, tests/evals/harness-scenarios.test.ts, tests/coordinator/coordinator-registry.test.ts, tests/workers/jobs.test.ts,
tests/terminal/cli.test.ts.

## The two-harness rule

Tandem supports exactly two harnesses: OMP (`"omp"`) and Claude Code (`"claude-code"`). There is
no third harness and no remote harness. Tasks, approvals, panes, durable state, and recovery behave
the same on either.

OMP works today. Claude Code is recognized but not runnable yet: resolving it throws
`HarnessUnavailableError` with a plain-English message naming the role and its model, so nothing
launches.

## The harness comes from the model

There is no harness setting. Each role's model in `<home>/models.json` decides where that role runs:

- A `claude-code/<model>` selector (for example `claude-code/opus`) runs the role in Claude Code.
- Any other selector, and an unset model (the harness's own default, used by the Tandem
  coordinator before models are chosen), runs it in OMP.

`harnessOf(model)` in src/harness/contract.ts is the only place this mapping lives. Roles may differ:
a coordinator on `claude-code/opus` with scouts and reviewers on `openai-codex/gpt-5.6` is a
supported configuration. Each agent's harness follows only its own model, never the coordinator's.
A model reassignment after a failure stays within the pinned model's harness.

## Where the launched harness is recorded

| Place | Field | Set from | Absent means |
| --- | --- | --- | --- |
| Coordinator record, `<home>/coordinator-registry/...json` | `harness`, always written | the launched coordinator model | OMP |
| Worker job spec | `harness`, always written | the job's resolved model | OMP |

- Reconnect, restart, reset, and `tandem fix` use the recorded harness, so they match what actually
  launched even if `models.json` changed since.
- `HarnessName` is a branded string that only `parseHarnessName` makes. An unknown value fails
  closed: a coordinator record is unreadable and a job spec is rejected. A record's `command[0]`
  must be its harness's `executable`.
- Records and jobs saved before this field load as OMP.
- Task policy carries no harness, so policy digests of existing tasks are unchanged. The models a
  task pins already determine its agents' harnesses.

## The Claude Code catalogue

Claude Code models are not in `omp models --json`, so Tandem keeps a fixed catalogue:

| Selector | Thinking levels |
| --- | --- |
| `claude-code/opus` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-code/sonnet` | `low`, `medium`, `high`, `max` |
| `claude-code/haiku` | `off` |

- `configure-models` and models.json validation accept these selectors alongside the OMP listing,
  and reject any other `claude-code/*` selector or an unsupported thinking level.
- Tandem never picks a Claude Code model on its own: onboarding's model choices, the balanced
  profile, and model reassignment read only the OMP listing. A Claude Code model is used only when
  the user names it.
- `claude-code` does not need to be in `enabledProviders`. That list gates only Tandem's automatic
  picks, never a selector the user chose, and Claude Code runs on the user's own Claude login.

## Resolving a harness

`harnessFor(name)` in src/harness/resolve.ts is the one place a name becomes a `Harness`.
`harnessForRole(role, model)` does the same for a role about to launch, and its refusal names the
role and the model. Callers outside src/harness/ never import src/harness/omp/launch.ts; Biome
enforces it.

- Launch derives the coordinator's harness from its model and resolves it before checking files,
  validating the model, or starting anything.
- A worker resolves its job's harness before running setup commands.
- A coordinator with no record predates harness choice, so the unrecorded-coordinator check uses
  OMP.
- The OMP model listing and MCP listing are home-wide, so they always come from OMP.

## The launch port

`Harness` in src/harness/contract.ts is what launch and ownership need from one harness: the
executable, the coordinator's checked-in files, building a command from a `LaunchSpec`, matching
live processes to a recorded command, the `ps` needle for a recorded session, and model and MCP
listing. Only src/harness/omp/ and tests/harness/omp/ may import `@oh-my-pi/*`.

## Later

- The setup page groups models by harness and offers presets such as "Claude coordinates, Codex
  researches and reviews". It waits until Claude Code runs, because offering a choice that fails
  closed is worse than not offering it.
