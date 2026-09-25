# Brief: run Tandem on Claude Code as well as OMP

## Goal

Let a project choose Claude Code instead of OMP for its coordinator and child agents. Tasks,
approvals, panes, durable state and recovery work the same either way. OMP keeps working
throughout, and neither harness's details leak into the rest of Tandem.

## How it works

- Tandem's decisions (tool actions, tool guards, notifications, prompt routing, compaction digest,
  usage, worker reports, steering, stall checks) live in a harness-neutral core. The core takes
  events and returns effects. It never calls OMP or Claude Code itself.
- Each harness has an adapter that turns its native events into core events and carries out the
  core's effects.
- On OMP the adapter is the extension that already runs inside `omp`.
- On Claude Code the adapter is a plugin loaded with `--plugin-dir`. Its MCP server lives for the
  whole session, owns the core session object, exposes the Tandem tools, and pushes wake-ups
  through a Channel. Its hooks are thin clients that forward each event to that server.
- The harness a coordinator or task was launched with is saved with it, so reconnect, restart and
  `tandem fix` always use the same harness.

## Why

Tandem only runs on OMP today. The OMP coupling is spread across about 4,000 lines of `pi.on`
handlers (`src/extension.ts`, `src/extension/`, `src/worker-control.ts`,
`src/workers/terminal-extension.ts`) plus argv and process matching in `src/coordinator/launch.ts`,
`src/coordinator/ownership.ts`, `src/worker.ts` and `src/adapters/omp.ts`. Adding a second harness
without a seam would put `if omp` branches through all of it.

A spike on 2026-09-25 showed a locally built Channel (`--dangerously-load-development-channels
server:<name>`) wakes an idle interactive Claude Code session in about 4 to 5 seconds. Mid-turn
pushes queue until the running tool finishes. Rapid pushes are batched in order. A half-typed draft
in the input box is left alone. `meta` fields reach the model without showing in the pane. The
session still writes its transcript with usage.

## Architecture

```
src/
  session/            harness-neutral core: no @oh-my-pi imports, no claude flags
    events.ts         core event and effect types
    tools.ts          tandem and submit_report schemas as plain zod
    coordinator.ts    coordinator session logic
    worker.ts         worker session logic
  harness/
    contract.ts       the launch port, the session port, and Capabilities
    omp/              everything that imports @oh-my-pi or knows omp flags
    claude/           launch, plugin files, MCP host with channel, hook client, transcript usage
```

**Launch port** (used by `coordinator/`, `service/`, `pool/`): build the coordinator and worker
commands from one `LaunchSpec`, match a live process against a saved record (fails closed), list
models, declare capabilities.

**Session port** (used inside the agent process, types in `src/session/events.ts`):

- Events: `sessionStart`, `userPrompt`, `agentStart`, `turnStart`, `streaming`, `toolCall`,
  `toolStart`, `toolEnd`, `turnEnd(usage)`, `agentEnd(willContinue, interrupted, failure)`,
  `contextBuild`, `stopRequested`, `compacting`, `compacted`, `shutdown`.
- Hook replies, returned from the same hook: tool decision (`block`), `{ handled }` for a prompt,
  system context, task-message placement, `continueWith` on stop, compaction context.
- Effects, awaited through `host.perform` so a failed send can roll back: `deliver({ text, hidden,
  timing, triggerTurn })`, `promptAsUser`, `notify`, `recordEntry`, `compact` (not awaited, it
  re-enters the session), `abort`, `shutdown`.
- Host queries: `confirm`, `contextTokens`, `paneState`, `assertSelectedModel`, `mcpToolPrefix`.
- Tools are classified into a `ToolKind` (`read`, `write`, `edit`, `shell`, `mcp`, `ask`, ...) by
  the adapter. Guards match on kinds, never on native names like `read`, `Bash` or `xd://mcp__`.

| Core effect | OMP | Claude Code |
| --- | --- | --- |
| `deliver` | `pi.sendMessage` | Channel push. Herdr typing into the pane is the fallback |
| `block` | `tool_call` returns `{ block }` | `PreToolUse` deny |
| `addContext` | `before_agent_start` / `context` | `SessionStart` / `UserPromptSubmit` `additionalContext` |
| `turnEnd(usage)` | `turn_end` event | `Stop` hook reads new transcript lines |
| `compact()` | `ctx.compact()` | not supported. The capability is off |

## Code principles

All new and moved code follows `~/.claude/skills/refactor-functions/SKILL.md`:

- **Honesty.** One session class per role (`CoordinatorSession`, `WorkerSession`,
  `WorkerSteering`) holds its state, with `SessionDeps` (host, clock, timers, status, logError,
  plus role deps) injected at the boundary. Pure decisions stay plain functions. A reducer was
  rejected because handlers run concurrently today, and queueing events would change timing.
  Only the adapters touch the harness.
- **Empathic signatures.** One `LaunchSpec` instead of long flag lists. Branded `TaskId`,
  `SessionId` and `HarnessName` where they are already validated. Names say what they return.
- **Uniform abstraction.** Protocol details (channel payloads, hook JSON, argv quirks) stay in the
  adapters, and domain decisions stay in the core.
- **Comment hygiene and reader-oriented declaration order** in every touched file.
- Each extraction PR lists every function it moved or changed with a disposition: changed,
  unchanged with a reason, or blocked.

These do not override "prefer simple": no wrapping short signatures or extracting trivial helpers.

## Scope

1. **Extract the core.** Move Tandem logic out of the OMP handlers into `src/session/`. This is a
   pure refactor, and OMP behavior does not change. Packages:
   - **P0** (first, alone): move the pure `src/extension/*` modules to `src/session/`, add a
     direct `zod` dependency (`pi.zod` is OMP's shim, not zod), `session/events.ts`,
     `session/tools.ts` with a schema parity test, and a recording host in `tests/evals/scenario.ts`.
   - Then in parallel, with no shared files: **A1** coordinator tools and prompt routing, **A2**
     coordinator lifecycle (`CoordinatorSession`), **B** worker (`WorkerSession`,
     `WorkerSteering`).
2. **Add the seam.** Add `src/harness/contract.ts`, move the OMP code under `src/harness/omp/`, and
   make `ownership.ts`, `launch.ts` and `worker.ts` go through the launch port. Biome
   `noRestrictedImports` bans `@oh-my-pi/*` outside `src/harness/omp/` and its tests. The extension
   path is part of coordinator ownership (`COORDINATOR_EXTENSION_PATH`), so the move must still
   recognize coordinators launched from the old path, or require `tandem update`.
3. **Record the harness.** Add a harness setting to onboarding and settings, pin it in the task
   policy and the coordinator record, and fail closed on an unknown value.
4. **Claude Code coordinator.** Plugin, MCP host with the `tandem` tool and channel, hooks,
   launch, and ownership by `--session-id`. Launches are isolated (`--strict-mcp-config`, no user
   plugins) and step through the dev-channel warning via Herdr.
5. **Claude Code workers.** `submit_report` and `copy_asset` over MCP, the read-only guard via
   `PreToolUse`, steering via the channel, and usage from the transcript.

## Constraints

- OMP behavior is unchanged by steps 1 to 3.
- Safety boundaries in AGENTS.md hold for both harnesses: fail closed on ownership, durable records
  are authoritative, fresh reviewers are read-only, no auto-merge.
- The core never asks which harness it runs on. It checks `Capabilities` (`proactiveCompaction`,
  `hiddenMessages`, `streamingProgress`, `perActionApproval`).
- Channel messages carry the task id in `meta`. The coordinator treats `tandem` channel messages as
  authoritative, but a push is never assumed to have been acted on. Durable state stays the source
  of truth.
- Update `AGENTS.md` ("No remote fleets or alternate harnesses") and
  `docs/reference/operating-model.md` to allow exactly these two harnesses. Add
  `docs/reference/harness.md` for the contract.

## Open questions

- **Prompt routing** (`src/extension/prompt-routing.ts`) answers some prompts without a model turn.
  `UserPromptSubmit` can block a prompt but cannot swap in an answer. The candidate is to block and
  reply through the channel. Needs a spike before step 4.
- **Worker pane keys and editor text** (`ctx.ui.onTerminalInput`, `getEditorText`) have no Claude
  Code equivalent. Move them to `tandem` commands or drop them on Claude Code.
- **Worker steering.** On OMP it rewrites the conversation history (the `context` event plus
  marker collapse). Claude Code has no equivalent, so steering there goes through a channel push
  or the Stop hook's continue.
- **Per-action approval.** One MCP tool gets one permission prompt. We may split `tandem` into
  read and write tools.
- **Channel risks.** Research preview. Resume can silently drop the channel grant
  ([#78028](https://github.com/anthropics/claude-code/issues/78028)), so restart must check the
  channel works. Idle wake sometimes fails
  ([#44380](https://github.com/anthropics/claude-code/issues/44380)), so keep the Herdr-typing
  fallback.

## Non-goals

- Headless `claude -p` workers or Claude Code agent teams. Panes stay interactive and Tandem keeps
  its own durable state.
- Bedrock, Vertex or Foundry (Channels need claude.ai or Anthropic API auth).
- Cross-provider model fallback on Claude Code.
- Proactive compaction on Claude Code.

## Acceptance criteria

- After steps 1 and 2, `bun run check`, `bun test` and `bun run lint` pass, and no file outside
  `src/harness/omp/` and its tests imports `@oh-my-pi/*`.
- `src/session/` has no imports from `src/harness/` or `@oh-my-pi/*` and no direct I/O imports.
  The service, store and filesystem arrive through deps.
- A coordinator record saved before step 3 still reconnects on OMP. A record with an unknown
  harness fails closed.
- On Claude Code, a child finishing wakes an idle coordinator with a message carrying the task id,
  and a restart detects a missing channel.
- On Claude Code, a fresh reviewer cannot edit files or run mutating shell commands.
- Scenario evals in `tests/evals/` run against a fake harness, and each adapter has tests for its
  own translation.

## Manual verification

- Start a task on OMP and on Claude Code in isolated homes. Both reach review with the same task
  states.
- Leave a Claude Code coordinator idle while a child finishes. It wakes up and reports the result.
