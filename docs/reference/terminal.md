# Terminal backends

Tandem supports Herdr and Tern on macOS. The terminal port owns panes, focus, process proof,
native hosting and alerts; task policy and durable state remain in TypeScript.

Start here for terminal behavior. [Tern view hosting](tern-views.md) defines the Luau API,
layout tickets and renderer lifecycle. [Native view data](native-views.md) defines the JSON
models and publication. Approval and posting remain in [request briefs](request-briefs.md)
and [PR review](pr-review.md).

Code: `src/terminal-backend/contract.ts`, `compose.ts`, `identity.ts`, `setting.ts`,
`herdr/`, `tern/`; `tern-plugin/`; `src/terminal/native-renderers.ts`, `native-input.ts`.
Tests mirror these domains under `tests/terminal-backend/` and `tests/terminal/`.

## Choosing a terminal

`<home>/settings.toml` stores the top-level `terminal = "herdr"` or `terminal = "tern"`.
An absent key selects Herdr. `compose.ts` alone selects the implementation, reading the saved
choice before operations and caching each adapter's uncertain-effect guard. Injected callers
can supply a fixed choice with the same identity guards.

Chat setup, the setup page and direct interactive onboarding offer Tern only when `probeTern`
returns `ready`. Its other results are `missing`, `signedOut` and `unknown` with a reason;
new setup explains the result and uses Herdr. A previously saved choice remains selected when
readiness is unavailable; saving unrelated page settings does not switch terminals. Selecting
"Not now" in direct onboarding saves Herdr. The `terminal-setting` action rechecks Tern before
saving a changed choice. Tern is a closed beta and requires a signed-in Stencil account.

The probe resolves `tern` from PATH, then `/Applications/Tern.app/Contents/MacOS/tern`.
It checks the version and the account gate in its own temporary configuration, daemon socket,
Tandem home and control window. A headless account is synthetic and cannot prove sign-in.
The probe's own window may briefly appear in front. It closes that window and aborts and awaits
its owned processes, without hiding the app or touching other windows. The check has an
eight-second budget, with one second for control-window shutdown; timeout or failed cleanup
returns `unknown`. A version string alone does not mean ready.

Switching terminals is refused under the state lock while any task is unfinished, including
paused, blocked, ready or awaiting approval, or tasks/presentations retain active jobs,
endpoints, reservations, pending endpoint launches or quarantined operations. Availability is
checked outside the lock; the live-work guard runs immediately before saving. Finish or safely
stop the existing work through normal task controls before choosing the other terminal.

## Tern mapping

| Tandem port concept | Tern resource |
| --- | --- |
| Terminal session (`Endpoint.sessionId`) | Daemon namespace, with the Tandem session name |
| Project (`Endpoint.terminalSessionId`) | One uniquely named native Tern session |
| Workspace and tab (`workspaceId`, `tabId`) | The same native Tern tab id |
| Pane (`paneId`) | Exact native block id |

The coordinator starts in the project's first tab. Workers get background tabs in that session,
in creation order. Display names include the project and a path/session digest, with collision
suffixes as needed. A name never authorizes adopting an existing session.

Each project also has a dedicated background PTY tab named "Tandem alerts". Its exact pane,
tab and workspace are recorded in the coordinator endpoint's `notificationPane`. The Luau
blocks have no PTY. Alerts use this recorded helper, prove its shell process and tty with native
process evidence, recheck the process and exact pane, then write sanitized OSC 777 text to that
tty. They never send notification commands through an interactive agent's input. Missing,
ambiguous, foreign or busy helpers refuse delivery without choosing a substitute.

Native alerts cover needs you, done (a new draft PR) and stuck. A private, locked per-project
delivery cursor is saved before sending; repeated ticks, relaunches and unknown delivery outcomes
do not resend a claimed transition. The first snapshot establishes a baseline. Tern groups
alerts from one helper into one inbox entry, with a count and the latest title/body; clicking
it focuses that helper tab. Worker OMP completion/error/ask notifications are disabled;
coordinator ask notifications remain enabled. See [transition delivery](tern-views.md#transition-delivery).

## Identity, close and recovery guards

- Durable endpoints and pending launch intents carry `terminal:"herdr"|"tern"`. Historical
  untagged records decode as Herdr. Foreign endpoints are quarantined before inspection,
  close, recovery or navigation, even when their numeric strings happen to match. Derived
  navigation retains the tag. Launch environments remove the other backend's inherited pane
  variables; mixed inherited contexts refuse ownership.
- Tern ids stay decimal strings, including u64 values decoded before JSON number rounding.
  Native Luau layout calls additionally refuse ids outside JavaScript's safe integer range.
  Duplicate listing identities and malformed responses fail closed.
- Immediately before a pane mutation, re-read its exact id in `tern ls --json`, checking the
  recorded session and tab placement. Compare the returned block acknowledgement too. Titles
  are display text only: Tern's missing-id fallback can otherwise match a title and mutate an
  unrelated pane. Presence and absence proofs use the same window scope. Detached blocks leave
  absence ambiguous.
- Ordinary close first proves the foreground process group and its argv against native macOS
  evidence. A live pane without process proof is ambiguous. Busy panes refuse close unless the
  caller explicitly authorizes force; force still requires ownership and exact acknowledgement.
  Project close checks both coordinator and recorded alert helper before closing either.
- After close, prove the exact pane absent. If the session is empty, recheck its exact id and
  emptiness before `tern kill session`. Tern can retain its last empty session: an exact kill
  acknowledgement followed by no tabs is known cleanup, with no repeated kill. Other uncertain
  cleanup polls for at most five seconds, then quarantines and retains resources.
- Relaunch reuses only the stored `terminalSessionId`, rechecked immediately before creating
  a tab, including a retained empty session. An absent stored id permits a new session with a
  collision-safe name. Matching names never permit reuse. The alert helper is likewise reused
  only by its recorded identity in that session.
- Failed mutation responses, malformed acknowledgements and unconfirmed verification can follow
  a completed effect. They raise `TernOutcomeUnknownError`; the local guard blocks blind repeats
  and durable recovery retains ownership/resources. Never infer non-commit from a nonzero exit.
  Inspect saved state and use [central recovery](recovery.md), rather than clearing the owner.

Native hosting adds a private coordinator-bound intent lock, unique layout ticket and receipt.
It proves the exact program, all five launch arguments and placement, refusing duplicate matches
and conflicting detached/window evidence. A supplied window key must contain the exact origin
and coordinator; without one, exactly one attached window is required. Unknown openings retain
their fence and resources until exact block evidence settles them. Native closes prove the full
arguments and idle state again immediately before closing. See [hosting lifecycle](tern-views.md#native-hosting-and-renderer-launch-api).

## Native views and actions

Tern uses daemon-hosted Luau blocks (hosting decision B). TypeScript computes models, reads
GitHub/provider data and applies policy; Luau draws, keeps transient drafts and invokes the CLI.
Only `src/terminal-backend/tern/` calls the Tern CLI or parses its JSON. Only
`src/harness/omp/` imports `@oh-my-pi/*`.

Every published view is `{version:1,kind,revision,model}`. The root has `kind:"panel"` and
`model:NativeViews`; task/brief/PR details contain their domain model directly. Use
`nativeViewsPath` and `nativeDetailPath` to locate them. Missing or invalid files preserve the
last readable display but disable revision-bound actions. These derived files never authorize
an approval or post.

All blocks receive exactly five strings:
`{modelPath, coordinatorPaneId, coordinatorCwd, windowKeyOrEmpty, indexPath}`.
Argument five is the root index path. `navigation.origin` derives `home` from that path's
`<home>/native-views/<project>.json` location. It passes the renderer's own pane id on actions,
along with the supplied cwd, optional window key and derived custom-home flag.

Actions run once as `tandem native <verb> ... --pane <decimal id> --cwd <absolute path>
[--window <key>]`. The CLI validates project and origin ownership before acting. JSON actions
use `native-input.sh` and `src/terminal/native-input.ts`: stdin becomes one unique immutable UTF-8
file in a private 0700 directory, created exclusively as 0600 then made 0400. The caller deletes
it after the invocation settles. Exit zero means done or cancelled; nonzero stderr becomes a
toast. No renderer retries, including when feedback was saved or a post may have reached GitHub.

The registered screens and action handlers are in `tern-plugin/host.luau`, `plugin.toml` and
`src/terminal/native-renderers.ts`. The hosting API also supports layout kinds before their
renderer is registered; that alone does not make a screen available. The panel always shows
PRs, Board and usage buttons independently of shortcut consent.

### Registered screens

The current package registers Panel, Welcome, Brief and PR. `native prs` selects a project's
published PR and opens that PR pane; New request focuses and prompts the verified coordinator.
Project switching and published-detail file navigation are also implemented. Task, Board, Usage
and Catch-up have data models and hosting support, but their renderer registrations are still
pending. The Board, Usage and Open task command slots currently return an unavailable error.
Their panel buttons and palette entries remain visible.

## Tern 0.5.0 facts and limits

The initial probes and hosting comparison used 0.4.5; subsequent native hosting checks used
0.5.0. Treat these as observed version-specific behavior, and rerun isolated checks after an update.

- No creation-time `--env` option. After exact creation acknowledgement, the backend exports
  `TANDEM_SESSION`, `TANDEM_TERN_WORKSPACE_ID` and `TERN_PANE` into the created shell. Each
  launched command overrides inherited stale values from its owned endpoint as well.
- A handled custom layout route can make `tern open` exit nonzero with "cannot open in a file
  block" after opening successfully. The host requires a private receipt and exact scoped
  program/argument proof, even on exit zero. That error alone proves neither success nor failure.
- Split/detail blocks and task replacements use the default `keep_open=false`. On 0.5.0,
  `cx:exit(0)` removes that block; `keep_open=true` retains it and can still report `live=true`.
  Only exact-id absence proves closure. Task return restores the preserved conversation before
  removing its replacement block.
- There is no CLI pane-resize or tab-reorder operation. Port `fitPanel` and
  `orderWorkspaceAfter` return warnings; the native panel route can use the window layout API
  for its initial width. There is no notification CLI verb and no direct CLI block-open verb;
  hosting uses guarded file routes and alerts use the owned PTY helper.
- `WindowCx` has no documented window-key accessor. Actions use `TERN_WINDOW_KEY` only when
  known; otherwise unique-window proof is required. A missing-block error alone cannot
  distinguish an absent pane from an unknown window.

Native checks use a temporary `TERN_CONFIG_DIR`, `TERN_DAEMON_SOCKET`, Tandem home and owned
`--control` window. Screenshots and control actions target that window only. Tests never use
the user's Tern sessions, settings or live Tandem home, and fixtures never contain environment
dumps or secrets.

## Plugin consent and restoration

Selecting ready Tern consents to linking Tandem's native view package. One separate question
asks before setting global `tabs_autohide=true` and adding global shortcuts. Declining leaves
the settings byte-identical and remembers the decision. Palette commands and panel header
buttons remain available. To reconsider, choose Herdr, then Tern again in setup.

The shortcuts cover Board (⌘⇧B), PRs (⌘⇧P), Usage (⌘⇧U), projects (⌘1–9) and previous/next
project (⌘⇧[ / ⌘⇧]). Explicit custom bindings, modifier/physical-key aliases and sequences are
preserved. Alternate keymap presets are preserved as a whole; setup reports skipped keys or
the preset. Window commands register no default chords. New windows read the saved mappings.

Before applying approved changes, the private `settings.json.tandem.json` record saves the
decision, exact added key/action pairs, original keybind-table presence and sidebar's original
presence/value. Both settings and record writes are atomic, regular non-symlink files with
0600 permissions and stale-write checks. Unknown commit failures retain the record for
restoration. Existing records neither reapply user-removed settings nor repeatedly prompt.

Choosing Herdr restores only recorded bindings still equal to Tandem's installed actions and
the sidebar only while it still has Tandem's installed value. Later user edits and unrelated
settings survive; successful restoration removes the record. Failed restoration warns and keeps
the record without blocking Herdr. The plugin remains linked. `tandem update` reloads an
existing selected Tern package without prompting or installing a missing package.
