# Terminal backends

Tandem supports Herdr and Tern on macOS. The terminal port owns panes, focus, process proof,
native view hosting and alerts. Task policy and durable state stay in TypeScript.
The Tern iOS app is **UNTESTED** with Tandem.

Start here for terminal behavior. [Native views](native-views.md) covers the Tern views: their
store, contracts, click transport, staged opens and every screen. Approval and posting stay in
[request briefs](request-briefs.md) and [PR review](pr-review.md).

Code: `src/terminal-backend/contract.ts`, `compose.ts`, `identity.ts`, `setting.ts`,
`herdr/`, `tern/`. Tests mirror these under `tests/terminal-backend/`.

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

## The terminal port

`TerminalBackend` in `src/terminal-backend/contract.ts` is every pane, workspace and session
effect Tandem has: inspect, run, send keys, interrupt, close, create and split, list, focus,
notify, the panel and the welcome view. Every operation that names a pane takes its full identity
and refuses a pane whose session, workspace or tab no longer match. Failures a caller decides on
are typed: `EndpointOwnershipError` for a missing or foreign pane and `EndpointBusyError` for an
active worker. Herdr (`herdr/`) and Tern (`tern/`) implement it. `compose.ts` alone picks one.

Native view hosting is the port's optional `views` capability (`ViewsCapability`): `open`,
`close`, `recover`, `retained` and `abandon`. Tern provides it. Herdr omits it, and callers branch
on `terminal.views` rather than on the terminal's name. Without `views`:

- a native open is refused with Herdr's unsupported-view reason,
- a brief opens in its request review pane,
- arrival notifications go through `notify` instead of native alerts, and
- the coordinator publishes no native views.

`quarantinedPanes` and `clearPaneQuarantine` expose Tern's durable pane quarantine to
`tandem fix`. Herdr returns none.

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

Native alerts cover needs you, done (a new draft PR) and stuck. The helper prints
`OSC 777;notify;<title>;<body>`. The UTF-8 wire sequence is `\u001b]777;notify;TITLE;BODY\u0007`
(ESC, `]`, the payload, BEL). The kind selects the title prefix and is not an extra OSC field.
`BODY` is the task's displayed title or summary:

| Kind | Title prefix |
| --- | --- |
| `needs-you` | `Tandem: Needs you` |
| `done` | `Tandem: Done` |
| `stuck` | `Tandem: Stuck` |

Title and body are single-line plain text: semicolons and C0, DEL and C1 control characters
(including ESC, BEL and newlines) become spaces before framing. A private, locked per-project
delivery cursor is saved before sending. Repeated ticks, relaunches and unknown delivery outcomes
do not resend a claimed transition. The first snapshot establishes a baseline. Tern groups alerts
from one helper into one inbox entry, with a count and the latest title and body, and a waiting
badge on the helper's tab. Activation first selects the helper tab. The window focus hook then
sends a `visit` entry, and the CLI proves the recorded helper, session and coordinator and focuses
that coordinator with its panel in the originating window. Titles never grant ownership. Failed
focus leaves alerts unread and runs no catch-up. The panel bell counts confirmed Tandem deliveries
since its own read cursor. See [the panel bell](native-views.md#panel-bell-and-read-cursor) and
[transition alerts](native-views.md#transition-alerts). Worker OMP completion, error and ask
notifications are disabled. Coordinator ask notifications stay enabled.

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
  evidence. Daemon-hosted Tandem blocks are recognized only by an exact `tandem.<block-id>`
  program with no child, foreground group or foreground process; discovery can skip them without
  treating them as agents or shells. Titles never prove that exception. Other live panes without
  process proof remain ambiguous. Busy panes refuse close unless the caller explicitly
  authorizes force; force still requires ownership and exact acknowledgement.
  Project close checks both coordinator and recorded alert helper before closing either.
  Before retiring a recorded coordinator, it also proves every claimed native view's program,
  all three launch arguments, project model paths, exact native session/tab/block and idle process state.
  It closes the conversation first, then rechecks and closes each view by exact id, including
  Brief, Board and Usage tabs, and finally the alert helper. Unrelated panes remain open.
  Unknown view-close acknowledgements or absence proofs retain the lease and a durable
  coordinator quarantine note; fresh adapters refuse to repeat the quarantined operation.
  Launch and restart also check that durable fence before replacing ownership or reusing the lease,
  including missing-pane/tab and cross-session paths. `tandem fix` lists and preserves the quarantine.
- Tern and macOS process-group reads are separate observations. A shell may exec or change
  groups between them. A failed native match can resample only after an exact-pane recheck and
  a demonstrably changed Tern process snapshot, for at most three attempts. Every successful
  sample still requires exact leader pid and argv in the native group. Stable disagreement,
  changed pane identity and continuous process churn fail closed. Ambiguous foreground proof
  for a recorded coordinator retains its lease and a durable coordinator quarantine note.
- After close, prove the exact pane absent. If the session is empty, recheck its exact id and
  emptiness before `tern kill session`. Tern can retain its last empty session: an exact kill
  acknowledgement followed by no tabs is known cleanup, with no repeated kill. Other uncertain
  cleanup polls for at most five seconds, then quarantines and retains resources.
- Relaunch reuses only the stored `terminalSessionId`, rechecked immediately before creating
  a tab, including a retained empty session. An absent stored id permits a new session with a
  collision-safe name. Matching names never permit reuse. The alert helper is likewise reused
  only by its recorded identity in that session.
- Every Tern effect goes through `mutate(op)` in `tern/cli.ts`, the only module that runs the
  Tern CLI (including `tern plugin` and the readiness probe) or writes the alert helper's tty.
  Biome forbids importing the command runner, `node:child_process` or the `Bun` global anywhere
  else under `tern/` (`process-reader.ts`, which runs `ps` for the process proof, is the one
  exception for `Bun`). The op union is closed
  (`focus`, `run`, `send`, `rename`, `split`, `newTab`, `newSession`, `close`, `killSession`,
  `open`, `browser`, `notify`) and takes only a `TernEndpoint`, which `identity.ts` narrows from a
  tag-checked endpoint. Each op rechecks the exact id, proves destructive targets idle, reads the
  durable quarantine, spawns, then checks the acknowledged id (the receipt for `open`).

## Quarantine and `tandem fix`

Besides coordinator quarantine notes, two durable Tern records make Tandem leave a resource alone
after an unknown outcome. Both live in files, so every later click and every coordinator process
sees them. `tandem fix` lists both and,
with `--yes`, removes one only after proving it safe. Never infer non-commit from a nonzero exit.
Inspect saved state and use [central recovery](recovery.md), rather than clearing the owner. See
[reconciliation](reconciliation.md#tandem-fix) for how `tandem fix` classifies each item.

### Quarantined panes

Failed mutation responses, malformed acknowledgements and unconfirmed verification can follow a
completed effect. They raise `TernOutcomeUnknownError`. For `run`, `send`, `rename`, `split`,
`close`, `killSession` and `notify`, `mutate` then writes a record to
`<home>/tern-quarantine/<sha256(key)>.json`. The record holds the pane key, operation, reason,
time, exact endpoint and cwd. A brief close, panel close or view-retirement close records against
the view pane it targeted. While a record exists, every later op on that pane, in any process,
refuses with `TernQuarantinedError` before spawning. Ops also refuse when the pane or its owning
coordinator has a coordinator quarantine note. A focus is idempotent and records nothing. Opens
record their own outcome as a ticket, and creations as their launch reservation.

A record goes away in two ways:

- A close that finds its pane absent from an exact scoped listing with no detached blocks returns
  absent. When the listing covers every window, it drops the record, so replacing a coordinator
  or helper still succeeds. A window-scoped listing cannot see other windows, so it keeps the
  record.
- `tandem fix` lists every record through `quarantinedPanes`. With `--yes`, it clears one through
  `clearPaneQuarantine` only after proving its pane gone or idle at the exact id. The pane itself
  is never closed.

### Paused view opens

A staged open whose outcome was never proved keeps its ticket under
`<home>/tern/<projectKey>/open/`. While that ticket stays, every new native view for its
coordinator is refused. Returning to the orchestrator still focuses the conversation and warns
that new views stay paused. The click, the coordinator's publication tick (`views.recover`) and
`tandem fix` all decide retained tickets, so a late receipt lifts the pause without another
click. See [staged opens](native-views.md#staged-opens) for the state machine.

`tandem fix` lists each paused open through `views.retained`, with its view kind and the reason
it is unproven. With `--yes`, it abandons one through `views.abandon` only after proving its
coordinator exactly present or exactly gone. Abandoning removes the ticket and its receipt. No
pane is closed and nothing is reopened.

## Native views

Tern hosts Tandem's views as daemon-hosted Luau blocks. TypeScript computes the models, reads
GitHub and provider data and applies policy. Luau draws, keeps transient drafts and sends clicks
through `tandem native act`. [Native views](native-views.md) is the reference for all of it.

## Tern 0.5.0 facts and limits

The initial probes and hosting comparison used 0.4.5; subsequent native hosting checks used
0.5.0. Treat these as observed version-specific behavior, and rerun isolated checks after an update.

- No creation-time `--env` option. After exact creation acknowledgement, the backend exports
  `TANDEM_SESSION`, `TANDEM_TERN_WORKSPACE_ID` and `TERN_PANE` into the created shell. Each
  launched command overrides inherited stale values from its owned endpoint as well.
- A handled custom layout route can make `tern open` exit nonzero with "cannot open in a file
  block" after opening successfully. The host requires a private receipt and exact scoped
  program/argument proof, even on exit zero. That error alone proves neither success nor failure.
- Renderer blocks and task replacements explicitly use `keep_open=false`. On 0.5.0,
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

Plugin list, link and reload resolve an explicit executable override first, then `tern` from
injected `PATH` (or the process `PATH`), then the macOS app bundle executable. PATH-only
installs work without a bundle.

Selecting ready Tern consents to linking Tandem's native view package. One separate question
asks before setting global `tabs_autohide=true` and adding global shortcuts. Declining leaves
the settings byte-identical and remembers the decision. Palette commands and panel header
buttons remain available. To reconsider, choose Herdr, then Tern again in setup.

Link, consent, reload and restoration run under one machine-wide lock, `tandem-setup.lock`, in
Tern's config directory next to `settings.json`. That directory holds the plugin links and the
global settings every Tandem home shares, so separate homes serialize too. Inside the lock, setup
re-reads the catalog and links only when the package is absent; a caller that waited sees the
first caller's recorded decision and asks nothing. A waiting caller gives up after five minutes.
Restoration with no record returns without taking the lock.

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
