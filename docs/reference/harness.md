# Harnesses

Which agent program runs each of Tandem's agents, how Tandem derives and records it, and the launch
port every harness implements.

Code: src/harness/contract.ts (`HarnessName`, `harnessOf`, the `Harness` launch port), src/harness/resolve.ts
(`harnessFor`, `runnableModels`), src/harness/claude-code/models.ts (the Claude Code catalogue),
src/harness/omp/launch.ts, src/harness/claude-code/launch.ts (the Claude Code launch port),
src/harness/launch-io.ts (the effects a launch lends its harness), src/coordinator/launch.ts and
src/worker.ts (the ready waits), src/coordinator/record.ts, src/workers/jobs.ts,
src/workers/terminal-control.ts (exit keys), src/harness/coordinator-session.ts and
src/harness/worker-session.ts (setup both adapters share), src/harness/claude-code/ (`host.ts`,
`coordinator.ts`, `worker.ts`, `sidecar.ts`, `socket.ts`, `tool-specs.ts`: the Claude Code sidecar;
`plugins/`: the mods).
Tests: tests/harness/, tests/harness/claude-code/, tests/evals/harness-scenarios.test.ts, tests/coordinator/coordinator-registry.test.ts, tests/workers/jobs.test.ts,
tests/workers/terminal.test.ts, tests/terminal/cli.test.ts.

## The two-harness rule

Tandem supports exactly two harnesses: OMP (`"omp"`) and Claude Code (`"claude-code"`). There is
no third harness and no remote harness. Tasks, approvals, panes, durable state, and recovery behave
the same on either.

Both harnesses run every role: the coordinator, scouts, implementers, reviewers (including PR
reviews), and presentations. See [The Claude Code coordinator](#the-claude-code-coordinator) and
[Claude Code workers](#claude-code-workers).

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
- Tandem never picks a Claude Code model on its own: the balanced profile and model reassignment
  read only the OMP listing. A Claude Code model is used only when the user names it or picks a
  preset that names it (see [Presets](#presets)), and then approves the recap.
- `claude-code` does not need to be in `enabledProviders`. That list gates only Tandem's automatic
  picks, never a selector the user chose, and Claude Code runs on the user's own Claude login.

## Presets

Setup offers three one-click choices for all five roles, on the setup page and in chat
onboarding (the `models` action returns them as `presets`). A preset only fills the choices: the
user can still change any role and approves the full recap, which names each role's harness.
Code: src/config/model-presets.ts (pure), src/harness/claude-code/availability.ts (the probe).

| Preset | Planning | Research | Coding | Review | Mockups |
| --- | --- | --- | --- | --- | --- |
| Claude coordinates, Codex researches and reviews | `claude-code/opus` | top Codex | `claude-code/opus` | top Codex | `claude-code/sonnet` |
| All Claude Code | `claude-code/opus` | `claude-code/sonnet` | `claude-code/opus` | `claude-code/fable` | `claude-code/sonnet` |
| All OMP | Balanced | Balanced | Balanced | Balanced | Balanced |

- Thinking is the Balanced profile's level for the role, moved to the nearest level the model
  supports. Balanced is `resolveBalancedProfile` over every provider OMP lists; the user's Save
  approves the providers the recap names.
- Top Codex is the reasoning model with the highest published output price, then input price,
  from OMP's `openai-codex` provider, else from `openai`. Names always come from the live listing.
- A preset is disabled, with its reason, when a role has no model: Claude Code is not installed
  (`claude --version` fails), a settings file a launch reads switches mods off (below), OMP lists
  no Codex or OpenAI model, or Balanced finds no model for a role.
- Mods are off when one of these is `true`. The reason names the setting and the file.

  | File | Settings read |
  | --- | --- |
  | `/Library/Application Support/ClaudeCode/managed-settings.json` and `managed-settings.d/*.json` | `disableAllHooks`, `allowManagedHooksOnly`, `disableSideloadFlags` (rejects `--plugin-dir`), and the built-in guard's `pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly` |
  | `<checkout>/.claude/settings.json` | `disableAllHooks` |
  | `<checkout>/.claude/settings.local.json` | `disableAllHooks` |

  Only these apply to Tandem's launches. `--setting-sources project,local` drops user settings, so
  `disableAllHooks` in `~/.claude/settings.json` does not stop Tandem's plugin; managed settings
  always apply. A worktree reads the main checkout's `settings.local.json`, and its committed
  `settings.json` matches the checkout's. Claude Code honors the other three settings only from
  managed settings. The MDM profile (`com.anthropic.claudecode`) is not read; mods it switches off
  end in the ready wait's error.
- The setup page's model pickers group models by harness: Claude Code's catalogue (only when it
  is ready), then OMP's listing. Thinking choices follow the picked model's levels. Claude Code is
  never added to `enabledProviders`; the recap says its roles use the Claude subscription.

## Resolving a harness

`harnessFor(name)` in src/harness/resolve.ts is the one place a harness name becomes a `Harness`:
a recorded name, or `harnessOf(model)` for a role about to launch. Callers outside src/harness/
never import either harness's `launch.ts`; Biome enforces it.

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
  launch refuses rather than start a second coordinator beside it. A Claude Code worker loads the
  same plugin but runs with `--name tandem-<agent>`, which is `no-match`, as OMP's worker
  extension is.
- The OMP model listing and MCP listing are home-wide, so they always come from OMP
  (`catalogueHarness`).
- A job's launch checks its pinned model against its own harness's listing (the
  `ModelCatalogueReader` takes the harness): OMP's listing for an OMP model, the fixed catalogue
  for a Claude Code one. Checked against OMP's listing alone, a task pinned to `claude-code/sonnet`
  stopped with "That model isn't listed right now" (seen live). A reassignment stays in the pinned
  model's harness and picks only from enabled providers, so it never needs another listing.
- `configure-models` accepts any selector in `runnableModels`: OMP's listing plus the Claude Code
  catalogue.

## The launch port

`Harness` in src/harness/contract.ts is what launch and ownership need from one harness:

| Member | OMP | Claude Code |
| --- | --- | --- |
| `executable`, `displayName` | `omp`, OMP | `claude`, Claude Code |
| `coordinatorFiles` (name, path, file or directory) | `extension`, `config` files | `adapter plugin`, `renderer plugin` directories |
| `launchEnvironment` (every agent) | none | `DISABLE_GROWTHBOOK=1` |
| `clearedEnvironment` (every agent) | none | Claude Code's nested-session variables (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, its session, bridge, and messaging ids, `CLAUDE_PID`) |
| `exitKeys` | `ctrl+d` | `ctrl+d ctrl+d`: the first only asks "Press Ctrl-D again to exit" |
| `conversation` | the directory as asked; none without one | the recorded id or a new one (below), always |
| `awaitReady` | resolves at once | waits for the sidecar (below) |
| `command(spec)` | coordinator and workers | coordinator and workers |
| `sameCommand` | ignores `--continue` | `--session-id X` and `--resume X` match |
| `processNeedle` | `--session-dir <dir>` | the conversation id |
| `listModels`, `validateModel` | `omp models --json` | the fixed catalogue, no command run |
| `listMcpServers` | OMP's servers | none (`--strict-mcp-config`) |

Coordinator and worker launch hand the harness a `LaunchIo` (read and write a file, new id, ask a
socket for `/health`, sleep, a monotonic clock; `launchIo` in src/harness/launch-io.ts), so each
harness's decisions are tested without real effects.
The CLI's `--extension` and `--config` confirm the coordinator files with those names; naming one
for a Claude Code coordinator, which loads neither, is refused. `doctor` checks each file by its
name. Only src/harness/omp/ and tests/harness/omp/ may import `@oh-my-pi/*`.

## The Claude Code coordinator

A coordinator on a `claude-code/<model>` selector runs:

```
claude --plugin-dir <tandem> --plugin-dir <tandem-renderer> (--session-id <id> | --resume <id>)
  --model <alias> [--effort <level>] --setting-sources project,local --strict-mcp-config
  --no-chrome --disable-slash-commands --system-prompt-snapshot off --tools Read,AskUserQuestion
  [-- prompt]
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
| `--` before the prompt | `--tools` takes every argument up to the next option, so without it the prompt is read as a tool name and Claude Code starts with no prompt (seen live on 2.1.288). |
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

## Claude Code workers

A worker whose job records `claude-code` (its pinned model is `claude-code/<alias>`) runs in its
pane as `bun src/worker.ts <job>`, which runs:

```
claude --plugin-dir <tandem> --plugin-dir <tandem-renderer> (--session-id <id> | --resume <id>)
  --model <alias> [--effort <level>] --setting-sources project,local --strict-mcp-config
  --no-chrome --disable-slash-commands --system-prompt-snapshot off
  --permission-mode bypassPermissions --name tandem-<agent> --tools <role tools> -- <brief>
```

with `TANDEM_WORKER_JOB_PATH`, `TANDEM_WORKER_CONTROL` (when the task has communication), and
`DISABLE_GROWTHBOOK=1`, and with the nested-session variables removed, so a worker launched from a
service inside Claude Code is a session of its own.

| Agent | `--tools` (Claude Code's own) | The adapter adds |
| --- | --- | --- |
| scout | `Read,Grep,Glob,WebSearch,WebFetch,Agent,Write,Edit` | `submit_report`, `copy_asset` |
| reviewer | `Read,Grep,Glob` | `submit_report` |
| pr-reviewer | `Read,Grep,Glob,Bash` | `submit_report` |
| implementer | `Read,Grep,Glob,Edit,Write,Bash,TaskCreate,TaskUpdate,TaskList` | `submit_report` |
| presentation | `Read,Grep,Glob,Write,Edit` | `submit_report` |

These mirror OMP's lists. `WebFetch` stands in for OMP's `read` of a URL and `Agent` for `task`.
The scout's Write and Edit reach only the mockup folder Tandem names, and a PR review's Bash runs
only read-only commands; the tool guard below enforces both.

- **Permissions.** A worker runs unattended, as on OMP: `bypassPermissions` keeps Claude Code from
  asking, and Tandem's tool guard decides instead. Checked on 2.1.288 with
  `--setting-sources project,local`: the mode starts without a confirmation screen.
- **Conversation.** Every Claude Code worker names its conversation, because its sidecar's socket
  is named by it. A job with a `sessionDirectory` (a scout or implementer Tandem may continue)
  keeps the id in `<directory>/claude-code-conversation` once its sidecar answers, and a later
  launch resumes it with `--resume`; a job without one gets a new id each launch.
- **Ready wait.** `runWorkerJob` runs the ready wait beside Claude Code, as direct coordinator
  launch does. After 30 s with no sidecar it stops Claude Code (SIGTERM through the run's abort
  signal) and fails the job with the same plain-English reason, ending "so Tandem stopped this
  scout. ... Then restart the task." The trust question names the project's own checkout (git's
  common directory), since a worktree is trusted when its project is.
- **Closing.** Herdr sends both exit keys at once (`herdr pane send-keys <pane> ctrl+d ctrl+d`);
  the closer reads the harness from the job's spec. While the pane closes, the adapter refuses
  each prompt-box edit, which is how OMP's raw-key swallow behaves.
- **Mixing.** A coordinator on either harness launches workers on either: each job's harness
  follows its own pinned model. Checked live both ways on 2.1.288 (an OMP coordinator with a
  Claude Code scout; a Claude Code coordinator with Claude Code implementer and reviewer).

## The Claude Code sidecar

On Claude Code, the adapter is a mod: TypeScript inside a plugin, with no Node APIs and no imports
outside the plugin, so it cannot open `state.sqlite`. It starts a Bun sidecar with
`$.process.spawn` for the session's life. The sidecar holds the core session and the store; the
mod forwards Claude Code's hooks and carries out the sidecar's effects. The mods are in
src/harness/claude-code/plugins/ (see [The mods](#the-mods)). A coordinator's sidecar holds a
`CoordinatorSession` (coordinator.ts); a worker's holds a `WorkerSession` and `WorkerSteering`
(worker.ts), mirroring OMP's terminal-extension.ts and worker-control.ts.

### Lifecycle

- **Start.** The mod runs `bun src/harness/claude-code/sidecar.ts --session <id>` in the
  session's working directory, with Claude Code's environment, which carries `TANDEM_HOME` and the
  rest of the boundary environment. With `TANDEM_WORKER_JOB_PATH` set it runs that worker job: it
  reads the job, opens its steering (writing the starting receipt), and writes the starting
  terminal state before its ready line; a job it cannot read is a fatal line. Without it, it runs
  the coordinator.
- **Socket.** `<home>/sidecars/<first 16 hex of sha256(session id)>.sock` (`sidecarSocketPath` in
  `socket.ts`, which launch also uses for its ready wait), in a directory created
  with mode 0700. A path over 103 bytes (macOS allows 104 with the NUL) is refused with a message
  to use a shorter home.
- **Idempotent start.** A socket file nobody answers on was left by a killed sidecar and is
  removed. A socket that answers `GET /health` belongs to a live sidecar for the same session;
  the new one waits up to 3 s for it to let go, then refuses to start rather than run two owners.
- **Ready.** The first stdout line is
  `{"type":"ready","protocol":2,"socket":...,"pid":...,"tools":[...]}`, or
  `{"type":"fatal","protocol":2,"reason":...}` and exit 1 when startup fails. The mod refuses a
  ready line from another protocol version. `tools` are the session's own tools as
  `$.tool.register` takes them (`tool-specs.ts` builds them from the zod schemas the sidecar parses
  with): `tandem` for a coordinator; `submit_report` with the role's schema, and `copy_asset` for a
  scout, for a worker.
- **Stop.** SIGTERM, SIGHUP, its parent exiting (checked every second; `$.process.spawn` closes
  stdin from the start, so stdin cannot signal it), or a `shutdown` event: the sidecar refuses every
  unanswered question, stops listening, removes the socket only if it is still its own (same
  inode), shuts the session down, and exits 0. It takes SIGTERM and SIGHUP over from OMP's
  postmortem module, which the service loads through the OMP launch harness and which would exit
  with 143 before the socket is removed.
- **Reload.** A mod hot-reload kills the sidecar, and the mod's `session.start` spawns a new one,
  so the mod reads the socket path from each new ready line. State that lives only in memory
  (notifications already sent this process, held next-turn context, an open thread) starts over,
  as it does when OMP relaunches; durable state is in the store. A worker's new sidecar reopens its
  job from the files, writes a fresh starting receipt, and has no to-do list or reminder state
  until the worker acts again. Mods reload only when the plugin's files change.
- Stdout carries only protocol lines. The sidecar sends `console.log` to stderr.

### Events in

Each event is one JSON object in `POST /event`. The response body is the hook's reply. Unknown
types, unknown fields, and wrong field types get HTTP 400 and `{"type":"refused","reason":...}`
without reaching the session; a failure inside the session gets 500 and `refused`.

| Event | Fields | Reply | Coordinator | Worker |
| --- | --- | --- | --- | --- |
| `sessionStart` | `model` (the id Claude Code reports) | `done` | `sessionStart` | steering's and the session's `onSessionStart` |
| `userPrompt` | `text`, `interactive`, `attachments` | `promptRoute {handled}` | prompt routing, then `userPrompt` | `onHumanInput` for a typed prompt that is not the brief; never handled |
| `agentStart` | `prompt?` (the text the run begins with) | `turnContext {system, context}` | `agentStart` | `onAgentStart`; the prompt's newest steering batch is applied |
| `turnStart` | | `done` | `turnStart` | `onTurnStart` |
| `streaming` | | `done` | nothing | `onStreaming` |
| `toolCall` | `call {id, name, input}` | `toolDecision {block, reason?}` | coordinator tool guard | worker tool guard (`guardToolCall`) |
| `pluginTool` | `id`, `name`, `input` | `toolResult {text, isError}` | the `tandem` tool | the worker guard, then `submit_report` or `copy_asset` |
| `toolStart` | `call` | `done` | status line | `onToolStart` |
| `toolEnd` | `call`, `result?` | `toolContext {context}` | status line; no context | `onToolEnd` with the to-do list; pending steering as context |
| `turnEnd` | `usage?`, `contextTokens?` | `done` | usage ledger | `onTurnEnd`, the job's token tally |
| `agentEnd` | `interrupted`, `failure?`, `prompt?`, `answer?` | `done` | `agentEnd` with the run as one prompt and answer, final reconcile | `onAgentEnd` |
| `stopRequested` | `aborted` | `stop {continueWith?}` | none | steering's `onStopRequested` |
| `promptEdit` | `draft` | `editDecision {allowed}` | allowed; the draft is recorded | refused while the pane closes |
| `compacting` | | `compaction {instructions}` | `compacting` | no instructions |
| `compacted` | | `done` | `compacted` | nothing |
| `shutdown` | | `done` | stops the sidecar | stops the sidecar |
| `askAnswer` | `ask`, `allowed` | the asking hook's next reply | resumes `host.confirm` | resumes `host.confirm` |

- The sidecar classifies tool calls (`claudeCodeToolCall`): `Read`, `WebFetch` (its URL is the
  path, so the coordinator's web-read guard applies), `Grep`/`Glob`, `Write`, `Edit`/`NotebookEdit`,
  `Bash`, `Task`/`Agent`, the task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) as
  `todo`, `mcp__tandem__copy_asset` as `copy-asset`, `mcp__tandem__submit_report` as `other` (as
  OMP's `submit_report` is), other `mcp__*`, and everything else as `other`.
- A worker's guard is the core's `guardToolCall`, the same one OMP runs: the scout's mockup rule,
  read-only tools once the job is settled, timed out, or paused (so an implementer stops editing
  once it reports, during validation and review), a PR review's read-only shell, an implementer's
  pinned validation commands, and `reviewerToolRefusal`: a fresh reviewer's Write, Edit, Bash,
  subagent, and `copy_asset` are refused with "A reviewer only reads: it cannot edit files or run
  commands." Its `--tools` already leaves those out; the guard holds even if the list widens.
- The to-do list (`ClaudeCodeTodoList`): `TaskCreate` adds an item, whose id the mod sends from the
  call's result (the only tool whose result it sends); `TaskUpdate` changes its subject or status,
  and `deleted` reads as OMP's `abandoned`, so a worker drops a step that does not apply by
  deleting it. Claude Code 2.1.288 offers no `TodoWrite` in an interactive session.
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
a call to its own tools, and otherwise lets Claude Code go on as if Tandem were absent; a refused
`promptEdit` lets the edit through, so a dead sidecar never locks the prompt box.

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
  plugin. The mod's own tools come from the sidecar's ready line, so nothing is generated into
  the plugin.
- `tandem-renderer/` (plugin `tandem-renderer`) draws a `UserMessage` whose origin is
  `{ kind: 'plugin', name: 'tandem' }` as an empty `Box` until it is expanded, so a wake shows only
  its `$.ui.log` line and never its hidden part.

| Claude Code event | What the adapter does |
| --- | --- |
| `session.start` | Spawns the sidecar beside the plugin with `--session` `$.session.id()`, waits up to 8 s for its ready line, registers the tools it lists (as `mcp__tandem__<name>`, before the first prompt, since the first `session.start` is awaited), posts `sessionStart` with `$.session.model()`, and only then follows its later lines. A fatal line, an unreadable one, or no line stops it and shows a toast; the mod then has no tools and no socket and fails closed. A reload runs this again with a new sidecar. |
| `prompt.submit` | Skips Tandem's own submits. Posts `userPrompt` (`interactive` when the origin is the composer); `handled` drops the prompt. A prompt typed while idle then posts `agentStart` and carries `turnContext.context` as its `context`. |
| `turn.start` | Posts `agentStart` when the prompt did not (a wake, or a prompt typed over a running turn), then `turnStart`. Remembers the text and turn id. Both `agentStart`s carry the run's text as `prompt`. |
| `turn.step` (main loop) | Passes the response through chunk by chunk, posting `streaming` (not awaited) at most every 5 s. |
| `prompt.edit` | Posts `promptEdit` with whether text is left after the edit; a refusal returns the box unchanged, which consumes the edit. |
| `prompt.compose` | Appends `{ id: 'tandem:coordinator', text, scope: 'session' }` when the turn has system text. Needs `--system-prompt-snapshot off` to run per request. |
| `tool.call` | One of the tools the ready line listed: posts `pluginTool` and answers `{ result }`, or `{ deny }` for an error. Any other tool: `toolCall`; a block is `{ deny }`; else `toolStart`, the tool, `toolEnd`, and the reply's `context` is added to the tool's result, which the model reads and the person never sees. A hook that throws or times out denies. The mod's own `$.ui.ask` arrives here as `AskUserQuestion` and is passed through. |
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
| No history rewriting (no `context` event) | There is no `contextBuild` event, and the protocol refuses one. Worker steering arrives as new text instead; see [Steering a Claude Code worker](#steering-a-claude-code-worker). |
| No per-token events | `turn.step` streams the response to the mod, which reports `streaming` every few seconds, so a worker's stall watchdog sees a long reply as progress. The coordinator's host still reports `streamingProgress: false`. |
| No session exit | The `shutdown` effect throws `UNSUPPORTED_EFFECTS.shutdown`. Herdr ends a Claude Code worker with two Ctrl-D (`exitKeys`); the core does not send `shutdown` today. |
| No raw keystrokes | OMP swallows every key but Ctrl-D while a worker pane closes. Claude Code's adapter refuses each `prompt.edit` while the pane closes instead; Ctrl-D on an empty box is no edit, so the exit keys still work. |
| No session entries | `recordEntry` writes nothing. OMP saves these in its session file and nothing in Tandem reads them back; the store stays the record. |
| No synchronous editor text | `$.prompt.read()` is async and `paneState()` is not, so the pane keeps `draft` from each `promptEdit` and clears it when a typed prompt is sent. A worker reads it to hold a close or a mockup back while the person types. |
| No transcript reference | A Claude Code worker's result carries no `transcript` (OMP's session file and entry id); `tandem trace` has none to link. |
| No `TodoWrite` | The to-do list is built from `TaskCreate` and `TaskUpdate` (above). There are no phases, so a playbook step matches an item's subject. |
| No message list at turn end | `agentEnd` carries the run's prompt (`turn.start`'s text) and final answer (`turn.complete`'s `answer`), which the core reads as one user message and one assistant message, so the setup page's wait for the coordinator's answer to a comment matches. Without a prompt there are no messages and nothing matches. |
| No background-result wake | OMP marks a finished background command's wake, and a submitted worker stops it at once. Claude Code's task notification is an ordinary prompt to the adapter, so the turn runs; a submitted worker idle for 30 s still settles. |
| Model id, not selector | `assertSelectedModel("claude-code/<alias>")` passes when the reported id is the alias or contains it as a word (`claude-opus-5-5` for `opus`), and fails closed when no model was reported. |

### Steering a Claude Code worker

On OMP, steering is placed into context: each model request's `context` event finds the task's
newest marker in the conversation, replaces every copy of it with one current batch (marker
collapse), and marks that revision applied. The worker sees only the newest directions, once, at
its next request, even mid-turn. `WorkerSteering` runs this as `delivery: "context"`.

Claude Code shows a mod no conversation to rewrite, so `WorkerSteering` runs with
`delivery: "messages"`. Each batch newer than the applied one is handed over once as new text, at
the first of these:

1. **After a tool result, mid-turn.** `toolEnd`'s reply carries the batch as `context`, which
   Claude Code adds after that tool's result for the model only. The revision is applied then.
2. **As the turn stops.** `classic.Stop` blocks with the batch as the reason, so the model keeps
   going with it in the same turn. The revision is applied then; on OMP it is applied by the next
   context build.
3. **While the pane is idle.** The steering poll (every 250 ms) submits the batch as a prompt of
   its own (a `deliver` with source `steering`, shown with `$.ui.log`). It waits while the brief or
   another submit is still queued. The revision is applied when it is submitted.

A batch the brief already carries (directions given before approval) is applied when the run
starts with that prompt (`agentStart.prompt`). Nothing is ever removed from the conversation: each
batch lists every active message, so after several steers the model has read several cumulative
batches, newest last, where OMP's model holds only the newest. The receipt, `appliedRevision`, and
the controller's check that a result carries the canonical revision are the same on both.
