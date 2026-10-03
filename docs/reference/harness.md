# Harnesses

Which agent program runs each of Tandem's agents, how Tandem derives and records it, and the launch
port every harness implements.

Code: src/harness/contract.ts (`HarnessName`, `harnessOf`, the `Harness` launch port), src/harness/resolve.ts
(`harnessFor`, `harnessForRole`), src/harness/claude-code/models.ts (the Claude Code catalogue),
src/harness/omp/launch.ts, src/harness/claude-code/launch.ts (the Claude Code launch port),
src/coordinator/launch.ts (the ready wait), src/coordinator/record.ts, src/workers/jobs.ts,
src/harness/coordinator-session.ts (coordinator setup both adapters share), src/harness/claude-code/
(`host.ts`, `coordinator.ts`, `sidecar.ts`, `socket.ts`: the Claude Code sidecar; `tandem-tool.ts`;
`plugins/`: the mods).
Tests: tests/harness/, tests/harness/claude-code/, tests/evals/harness-scenarios.test.ts, tests/coordinator/coordinator-registry.test.ts, tests/workers/jobs.test.ts,
tests/terminal/cli.test.ts.

## The two-harness rule

Tandem supports exactly two harnesses: OMP (`"omp"`) and Claude Code (`"claude-code"`). There is
no third harness and no remote harness. Tasks, approvals, panes, durable state, and recovery behave
the same on either.

OMP runs every role. Claude Code runs the coordinator only (see [The Claude Code
coordinator](#the-claude-code-coordinator)); resolving it for any other role throws
`HarnessUnavailableError` with a plain-English message naming the role, so no worker launches on it.
Workers come with issue #200, step 6.

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

Claude Code models are not in `omp models --json`, so Tandem keeps a fixed catalogue of the
aliases `claude --model` accepts:

| Selector | Thinking levels |
| --- | --- |
| `claude-code/fable` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-code/opus` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-code/sonnet` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-code/haiku` | `off` |

Sources, checked against Claude Code 2.1.288: `claude --help` lists `--effort` values `low`,
`medium`, `high`, `xhigh`, `max`, and the [model configuration
page](https://code.claude.com/docs/en/model-config.md) lists the aliases and each model's levels.
On the Anthropic API, which a Claude login uses, `fable`, `opus`, and `sonnet` resolve to Fable
5.1, Opus 5.5, and Sonnet 5.5, which take all five levels. Haiku is not in the docs' effort table,
so it takes none. Where an alias resolves to an older model (Sonnet 4.6 on some cloud providers),
Claude Code runs an unsupported level at the highest level it supports below it.

- `configure-models` and models.json validation accept these selectors alongside the OMP listing,
  and reject any other `claude-code/*` selector or an unsupported thinking level.
- Tandem never picks a Claude Code model on its own: onboarding's model choices, the balanced
  profile, and model reassignment read only the OMP listing. A Claude Code model is used only when
  the user names it.
- `claude-code` does not need to be in `enabledProviders`. That list gates only Tandem's automatic
  picks, never a selector the user chose, and Claude Code runs on the user's own Claude login.

## Resolving a harness

`harnessFor(name, role)` in src/harness/resolve.ts is the one place a recorded name becomes a
`Harness`; coordinator records pass `"coordinator"` and worker job specs pass the job's role, so a
Claude Code coordinator record resolves while a Claude Code job spec is refused.
`harnessForRole(role, model)` does the same for a role about to launch, and its refusal names the
role and the model. Callers outside src/harness/ never import either harness's `launch.ts`; Biome
enforces it.

- Launching a new coordinator derives its harness from its model and resolves it before checking
  files, validating the model, or starting anything. Launch first looks for a running coordinator
  and reconnects to it on its recorded harness, so a `models.json` change never blocks reconnect.
  A restart resolves the replacement's harness before it closes the running coordinator.
- A worker job runs on the harness its spec records. New jobs take it from the task's pinned
  model, so a `models.json` change never moves an existing task to another harness.
- A worker resolves its job's harness before running setup commands.
- A coordinator with no record is checked against both harnesses (`coordinatorHarnesses`): each
  foreground process goes to the harness whose `looksLikeAgent` claims it. An unrecorded `claude`
  loading Tandem's adapter plugin is `unknown`, because its command line names no repository, so
  launch refuses rather than start a second coordinator beside it.
- The OMP model listing and MCP listing are home-wide, so they always come from OMP
  (`catalogueHarness`).

## The launch port

`Harness` in src/harness/contract.ts is what launch and ownership need from one harness:

| Member | OMP | Claude Code |
| --- | --- | --- |
| `executable` | `omp` | `claude` |
| `coordinatorFiles` (name, path, file or directory) | `extension`, `config` files | `adapter plugin`, `renderer plugin` directories |
| `launchEnvironment` | none | `DISABLE_GROWTHBOOK=1` |
| `clearedEnvironment` | none | Claude Code's nested-session variables (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, its session, bridge, and messaging ids, `CLAUDE_PID`) |
| `conversation` | the directory, as asked | the recorded id or a new one (below) |
| `awaitReady` | resolves at once | waits for the sidecar (below) |
| `command(spec)` | coordinator and workers | coordinator only; a worker kind throws |
| `sameCommand` | ignores `--continue` | `--session-id X` and `--resume X` match |
| `processNeedle` | `--session-dir <dir>` | the conversation id |
| `listModels`, `validateModel` | `omp models --json` | the fixed catalogue, no command run |
| `listMcpServers` | OMP's servers | none (`--strict-mcp-config`) |

Launch hands the harness a `LaunchIo` (read and write a file, new id, ask a socket for
`/health`, sleep, a monotonic clock), so each harness's decisions are tested without real effects.
The CLI's `--extension` and `--config` confirm the coordinator files with those names; naming one
for a Claude Code coordinator, which loads neither, is refused. `doctor` checks each file by its
name. Only src/harness/omp/ and tests/harness/omp/ may import `@oh-my-pi/*`.

## The Claude Code coordinator

A coordinator on a `claude-code/<model>` selector runs:

```
claude --plugin-dir <tandem> --plugin-dir <tandem-renderer> (--session-id <id> | --resume <id>)
  --model <alias> [--effort <level>] --setting-sources project,local --strict-mcp-config
  --no-chrome --disable-slash-commands --system-prompt-snapshot off --tools Read,AskUserQuestion
  [prompt]
```

The two plugins live in src/harness/claude-code/plugins/: `tandem` is the adapter mod and
`tandem-renderer` hides the prompts the adapter submits for Tandem. It runs in the coordinator's
clean worktree, the pane's working directory, with environment `DISABLE_GROWTHBOOK=1`.

| Flag | Why |
| --- | --- |
| `--plugin-dir` (twice) | Loads Tandem's adapter and renderer. `--safe-mode` would also drop them, so it is not used. |
| `--session-id` / `--resume` | Names the conversation: a new one is started with `--session-id`, a saved one continued with `--resume`. |
| `--model`, `--effort` | The alias after `claude-code/`; the thinking level as effort. Haiku (`off`) gets no `--effort`. |
| `--setting-sources project,local` | Keeps the Claude login but drops user settings, so the user's own plugins and hooks do not load. |
| `--strict-mcp-config`, `--no-chrome` | No MCP servers, and none of Claude in Chrome's built-in MCP tools. |
| `--disable-slash-commands` | Turns off every skill, so none loads into the coordinator. |
| `--system-prompt-snapshot off` | Lets the adapter add context on every turn, not only the first. |
| `--tools Read,AskUserQuestion` | The coordinator reads and asks; the adapter's `tandem` tool (`mcp__tandem__tandem`) is added by the plugin. |
| `DISABLE_GROWTHBOOK=1` | Keeps mods on when Claude Code's server-side flag would switch them off. |
| `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION ...` | A coordinator launched from inside Claude Code (or in a Herdr server started there) would inherit the parent's child-session marker and save no transcript, so `--resume` could never find it. Seen live on 2.1.288. |

**Conversation.** `--session-id` refuses an id already used, so each fresh conversation gets a new
UUID. Once the coordinator is ready, launch writes that id to
`<conversation directory>/claude-code-conversation` (the coordinator's `coordinator-sessions/<key>`).
A resuming launch (`tandem` without `--fresh`, `tandem update`) reads it and runs `--resume <id>`;
with no file it starts a fresh conversation. A file holding anything but a UUID fails closed and
says to run `tandem --fresh`. The pane's "press Enter to start it again" command names the same id
with `--resume`. The id is chosen before the command is built (`chooseConversation` is pure), and
the file is written only after the ready wait proves Claude Code started on that id.

**Ready wait.** The adapter starts the sidecar as Claude Code's session starts, so launch polls
`GET /health` on `sidecarSocketPath(home, id)` every 250 ms. The first answer means Claude Code
trusted the project and loaded the plugin. A home too long for the socket path is refused before the
pane starts. After 30 s with no answer the launch fails closed: the processes whose command line
names the id are stopped with SIGTERM, the startup rollback retires the new pane and releases the
lease, and the error says Claude Code did not load Tandem's plugin, that the usual causes are the
trust question and mods switched off, and what to do. In the caller's own pane (direct mode) the
wait runs beside the coordinator and ends when it exits; on timeout the same stop and error apply.

**Trust.** Claude Code loads mods only in a folder the user trusted. A coordinator runs in a fresh
git worktree of the project, and Claude Code trusts a worktree when it trusts the project's own
checkout (checked on 2.1.288). Trust is not inherited from a parent folder into a separate git
repository, so trusting the pool root does not help. Precondition: open `claude` once in the
project and choose "Yes, I trust this folder". Tandem never answers the trust question for the
user; an untrusted project ends in the ready wait's error, which names the project folder.

**Identity.** `sameCommand` holds only for two `claude` commands (argv[0] named `claude`, any
directory) that name exactly one conversation, the same id, with otherwise identical arguments.
A flag given twice (other than `--plugin-dir`), both conversation flags, or a conversation flag
without a value never matches. `looksLikeAgent` reads argv[0], because a native install runs a
versioned binary whose process name is its version.

## The Claude Code sidecar

On Claude Code, the adapter is a mod: TypeScript inside a plugin, with no Node APIs and no imports
outside the plugin, so it cannot open `state.sqlite`. It starts a Bun sidecar with
`$.process.spawn` for the session's life. The sidecar holds the core session and the store; the
mod forwards Claude Code's hooks and carries out the sidecar's effects. The mods are in
src/harness/claude-code/plugins/ (see [The mods](#the-mods)). Step 5 of issue #200 runs the
coordinator this way; step 6 adds workers.

### Lifecycle

- **Start.** The mod runs `bun src/harness/claude-code/sidecar.ts --role coordinator --session
  <id>` in the session's working directory, with Claude Code's environment, which carries
  `TANDEM_HOME` and the rest of the boundary environment. Only `coordinator` is accepted until the
  worker binding exists; any other role fails closed.
- **Socket.** `<home>/sidecars/<first 16 hex of sha256(session id)>.sock` (`sidecarSocketPath` in
  `socket.ts`, which launch also uses for its ready wait), in a directory created
  with mode 0700. A path over 103 bytes (macOS allows 104 with the NUL) is refused with a message
  to use a shorter home.
- **Idempotent start.** A socket file nobody answers on was left by a killed sidecar and is
  removed. A socket that answers `GET /health` belongs to a live sidecar for the same session;
  the new one waits up to 3 s for it to let go, then refuses to start rather than run two owners.
- **Ready.** The first stdout line is `{"type":"ready","protocol":1,"socket":...,"pid":...}`, or
  `{"type":"fatal","protocol":1,"reason":...}` and exit 1 when startup fails. The mod refuses a
  ready line from another protocol version.
- **Stop.** SIGTERM, SIGHUP, its parent exiting (checked every second; `$.process.spawn` closes
  stdin from the start, so stdin cannot signal it), or a `shutdown` event: the sidecar refuses every
  unanswered question, stops listening, removes the socket only if it is still its own (same
  inode), shuts the session down, and exits 0. It takes SIGTERM and SIGHUP over from OMP's
  postmortem module, which the service loads through the OMP launch harness and which would exit
  with 143 before the socket is removed.
- **Reload.** A mod hot-reload kills the sidecar, and the mod's `session.start` spawns a new one,
  so the mod reads the socket path from each new ready line. State that lives only in memory
  (notifications already sent this process, held next-turn context, an open thread) starts over,
  as it does when OMP relaunches; durable state is in the store.
- Stdout carries only protocol lines. The sidecar sends `console.log` to stderr.

### Events in

Each event is one JSON object in `POST /event`. The response body is the hook's reply. Unknown
types, unknown fields, and wrong field types get HTTP 400 and `{"type":"refused","reason":...}`
without reaching the session; a failure inside the session gets 500 and `refused`.

| Event | Fields | Reply | Session call |
| --- | --- | --- | --- |
| `sessionStart` | `model` (the id Claude Code reports) | `done` | `sessionStart` |
| `userPrompt` | `text`, `interactive`, `attachments` | `promptRoute {handled}` | prompt routing, then `userPrompt` |
| `agentStart` | | `turnContext {system, context}` | `agentStart` |
| `turnStart` | | `done` | `turnStart` |
| `toolCall` | `call {id, name, input}` | `toolDecision {block, reason?}` | coordinator tool guard |
| `tandemTool` | `id`, `input` | `toolResult {text, isError}` | the `tandem` tool |
| `toolStart`, `toolEnd` | `call` | `done` | status line |
| `turnEnd` | `usage?`, `contextTokens?` | `done` | usage ledger |
| `agentEnd` | `interrupted`, `failure?`, `prompt?`, `answer?` | `done` | `agentEnd` with the run as one prompt and answer, final reconcile |
| `stopRequested` | `aborted` | `stop {continueWith?}` | none for the coordinator |
| `compacting` | | `compaction {instructions}` | `compacting` |
| `compacted` | | `done` | `compacted` |
| `shutdown` | | `done` | stops the sidecar |
| `askAnswer` | `ask`, `allowed` | the asking hook's next reply | resumes `host.confirm` |

- The sidecar classifies tool calls (`claudeCodeToolCall`): `Read`, `WebFetch` (its URL is the
  path, so the coordinator's web-read guard applies), `Grep`/`Glob`, `Write`, `Edit`, `Bash`,
  `Task`/`Agent`, `TodoWrite`, `mcp__*`, and everything else as `other`.
- `turnContext.system` goes to the `tandem:coordinator` section of each `prompt.compose` in that
  turn. `turnContext.context` holds deliveries that did not wake the model; each is handed over
  once, as `prompt.submit` context of a typed prompt, or in the turn's section when the turn has
  no typed prompt (a wake).
- `compaction.instructions` is what the mod passes to `$.session.compact({ instructions })`.

**Approval.** `host.confirm` inside a hook ends that hook's HTTP response early with `{"type":"ask",
"ask":"ask-<n>","title":...,"message":...}`. The mod calls `$.ui.ask` inside the same Claude Code
hook (verified to wait past the 10 s hook limit) and posts `askAnswer`; that response is the hook's
next reply, which may be another `ask`. A confirm outside any hook has nobody to ask and is
refused. The mod parses every reply with `parseHookReply(event, body)` against the event that
started the hook.

**Fail closed.** When the sidecar refuses or cannot be reached, the mod denies a tool call, errors
a `tandem` call, and otherwise lets Claude Code go on as if Tandem were absent.

### Effects out

| Core effect | Stdout line(s) | Mod call |
| --- | --- | --- |
| `deliver` with `triggerTurn` | `log {text}`, then `submit {hidden + text}` | `$.ui.log`, `$.prompt.submit({ text, asUser: true })` |
| `deliver` without `triggerTurn` | `log {text}`; hidden + text held for `turnContext.context` | `$.ui.log` |
| `promptAsUser` | `submit {text}` | `$.prompt.submit({ text, asUser: true })` |
| `showCard`, `showStatus` | `log {text}` (and `submit` if `showStatus` wakes) | `$.ui.log` |
| `notify` | `toast {text, level}` | `$.ui.toast` |
| `compact` | `compact` | post `compacting`, then `$.session.compact`, after the turn if one is open |
| `abort` | `abort` | `$.turn.abort({ turnId })` of the running turn; none running, nothing |
| `recordEntry` | none | see below |
| `shutdown` | refused (throws) | see below |

The mod parses each line with `parseSidecarLine` and ignores, with a debug log, a line it cannot
read.

### The mods

Two plugins under src/harness/claude-code/plugins/, loaded with `--plugin-dir`:

- `tandem/` (plugin `tandem`), the adapter. `hooks/register.ts` is the hooks module and carries
  out decisions made in `hooks/translate.ts`, which never touches `$`. `hooks/protocol.ts` is the
  wire, which the sidecar imports from here because a mod can import only files inside its own
  plugin. `hooks/tandem-tool.ts` is the `tandem` tool's description and JSON schema, generated
  from src/session/tools.ts by `bun src/harness/claude-code/tandem-tool.ts`;
  tests/harness/claude-code/tandem-tool.test.ts fails when it drifts.
- `tandem-renderer/` (plugin `tandem-renderer`) draws a `UserMessage` whose origin is
  `{ kind: 'plugin', name: 'tandem' }` as an empty `Box` until it is expanded, so a wake shows only
  its `$.ui.log` line and never its hidden part.

| Claude Code event | What the adapter does |
| --- | --- |
| `session.start` | Registers `tandem` (as `mcp__tandem__tandem`), then spawns the sidecar beside the plugin with `--session` `$.session.id()`, waits up to 8 s for its ready line, posts `sessionStart` with `$.session.model()`, and only then follows its later lines. A fatal line, an unreadable one, or no line stops it and shows a toast; the mod then has no socket and fails closed. A reload runs this again with a new sidecar. |
| `prompt.submit` | Skips Tandem's own submits. Posts `userPrompt` (`interactive` when the origin is the composer); `handled` drops the prompt. A prompt typed while idle then posts `agentStart` and carries `turnContext.context` as its `context`. |
| `turn.start` | Posts `agentStart` when the prompt did not (a wake, or a prompt typed over a running turn), then `turnStart`. Remembers the text and turn id. |
| `prompt.compose` | Appends `{ id: 'tandem:coordinator', text, scope: 'session' }` when the turn has system text. Needs `--system-prompt-snapshot off` to run per request. |
| `tool.call` | `mcp__tandem__tandem`: posts `tandemTool` and answers `{ result }`, or `{ deny }` for an error. Any other tool: `toolCall`; a block is `{ deny }`; else `toolStart`, the tool, `toolEnd`. A hook that throws or times out denies. The mod's own `$.ui.ask` arrives here as `AskUserQuestion` and is passed through. |
| `classic.Stop` | Posts `stopRequested`; a `continueWith` becomes `{ block }`. |
| `turn.complete` (main loop) | Posts `turnEnd` with the turn's tokens, the rise in `$.session.usage()`'s cost since the last turn as `costUsd` (0 when either reading is missing), and `context.tokens`; then `agentEnd` with `isAborted`, a failure for `error` or `refusal`, the turn's prompt, and `answer`. |
| `session.compact` (main loop) | Posts `compacting` and adds its instructions after any the compaction had, then `compacted` unless skipped or `precompute`. One the sidecar asked for already has them. |
| `session.end` | Posts `shutdown` within 1 s, except for `clear` and `resume`. |

Every reply goes through `parseHookReply`; an `ask` goes to `$.ui.ask(question, ["Allow", "Deny"])`,
where a dismissed question is a denial. A sidecar that exits leaves the mod failing closed, and shows
a toast unless it exited 0, which it does only when asked to stop.

Checks: `claude plugin validate --strict` and `claude plugin test` on each plugin directory (with
`DISABLE_GROWTHBOOK=1` where the mods flag is served off). `register.ts` and the plugins' `tests/`
import `claude-code`, whose types Claude Code writes into `<plugin>/.claude-plugin/types/` (ignored
by git) on load. The repository's tsconfig.json excludes them, bunfig.toml keeps `bun test` out of
the plugins' `tests/`, and Biome skips the written types. Each plugin's tsconfig.json checks them
with `tsc -p <plugin>` once the types exist. protocol.ts and translate.ts stay under the
repository's tsc and bun tests.

### What Claude Code cannot do

| Limit | How the sidecar handles it |
| --- | --- |
| No mid-turn or mid-tool submit | Every `timing` lands the same way: a wake is submitted and Claude Code starts it once idle; any other delivery is shown now and given to the model with its next turn. |
| No history rewriting (no `context` event) | There is no `contextBuild` event, and the protocol refuses one. Worker steering will arrive as new messages (step 6). |
| No per-token progress | There is no `streaming` event; `streamingProgress` is false, so the stall watchdog is off. |
| No session exit | The `shutdown` effect throws `UNSUPPORTED_EFFECTS.shutdown`; Herdr closes a Tandem pane. The core does not send it today. |
| No raw keystrokes | Nothing maps OMP's `onTerminalInput` swallow while a worker pane closes; the worker binding (step 6) decides how a closing pane refuses input. |
| No session entries | `recordEntry` writes nothing. OMP saves these in its session file and nothing in Tandem reads them back; the store stays the record. |
| No editor text | `paneState().draft` is always false. Only the worker reads it, to hold a close back while the person types; step 6 revisits it. |
| No message list at turn end | `agentEnd` carries the run's prompt (`turn.start`'s text) and final answer (`turn.complete`'s `answer`), which the core reads as one user message and one assistant message, so the setup page's wait for the coordinator's answer to a comment matches. Without a prompt there are no messages and nothing matches. |
| Model id, not selector | `assertSelectedModel("claude-code/<alias>")` passes when the reported id is the alias or contains it as a word (`claude-opus-5-5` for `opus`), and fails closed when no model was reported. |

## Later

- The setup page groups models by harness and offers presets such as "Claude coordinates, Codex
  researches and reviews". It waits until Claude Code runs workers too, because offering a choice
  that fails closed is worse than not offering it.
