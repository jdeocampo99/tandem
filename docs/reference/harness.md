# Harnesses

Which agent program runs a project's coordinator and child agents, how Tandem records that choice,
and the launch port every harness implements.

Code: src/harness/contract.ts (`HarnessName`, the `Harness` launch port), src/harness/resolve.ts
(`harnessFor`), src/harness/omp/launch.ts, src/config/policy.ts (`policyHarness`),
src/coordinator/record.ts, src/workers/jobs.ts.
Tests: tests/harness/, tests/config/policy.test.ts, tests/tasks/store.test.ts,
tests/coordinator/coordinator-registry.test.ts, tests/workers/jobs.test.ts.

## The two-harness rule

Tandem supports exactly two harnesses: OMP (`"omp"`) and Claude Code (`"claude-code"`). Each
project picks one, and its coordinator and every child agent run on it. Tasks, approvals, panes,
durable state, and recovery behave the same on either. There is no third harness, no remote
harness, and no mixing within one project.

OMP is the default. Claude Code is recorded but not runnable yet: resolving it throws
`HarnessUnavailableError` with a plain-English message that names the fix, so nothing launches.

## Where the choice lives

| Place | Field | Absent means |
| --- | --- | --- |
| Project settings, `<home>/repositories/<key>/settings.toml` | `harness = "omp" \| "claude-code"` | OMP |
| Task policy, pinned at task creation | `policy.config.harness`, written only when not OMP | OMP |
| Coordinator record, `<home>/coordinator-registry/...json` | `harness`, always written | OMP |
| Worker job spec | `harness`, always written from the task policy | OMP |

- `HarnessName` is a branded string. `parseHarnessName` is the only way to make one, at each
  boundary above. Any other value fails closed: settings refuse to load, a task record is
  `StateCorruptionError`, a coordinator record is unreadable, a job spec is rejected.
- The policy field is never written as `"omp"`, so policies pinned before harness choice keep their
  digest and the evidence bound to it.
- Records, policies, and jobs saved before this field load as OMP and reconnect unchanged.
- Changing the setting affects new tasks and the next coordinator launch. A running coordinator and
  pinned tasks keep their recorded harness.

## Resolving a harness

`harnessFor(name)` in src/harness/resolve.ts is the one place a name becomes a `Harness`. Callers
outside src/harness/ never import src/harness/omp/launch.ts; Biome enforces it.

- Launch resolves the project's harness from policy before checking files or starting anything.
- Reconnect, restart, reset, and `tandem fix` match processes with the harness the coordinator
  record names. A record's `command[0]` must be that harness's `executable`.
- A worker resolves its job's harness before running setup commands.
- A coordinator with no record predates harness choice, so the unrecorded-coordinator check uses
  OMP.
- Model catalogue and MCP listing are home-wide, not per project, so they use the default harness.

## The launch port

`Harness` in src/harness/contract.ts is what launch and ownership need from one harness: the
executable, the coordinator's checked-in files, building a command from a `LaunchSpec`, matching
live processes to a recorded command, the `ps` needle for a recorded session, and model and MCP
listing. Only src/harness/omp/ and tests/harness/omp/ may import `@oh-my-pi/*`.
