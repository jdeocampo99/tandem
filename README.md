# Tandem

Tandem lets you hand coding work to AI agents without babysitting them. You say what you want and
approve the plan. Tandem handles the rest: it splits the work across agents, gives each one its own
copy of the repository, checks and reviews every change, and remembers where everything stands. You
stop juggling context windows, worktrees, and a mental list of half-finished tasks. You just ask.

Tandem runs locally on your Mac.

## Why use it

- **No context juggling.** Each job gets a fresh agent with only what it needs, so you're never
  nursing one long chat that's losing the thread.
- **No worktree chores.** Tandem creates, reuses, and cleans up worktrees for you. Your own checkout
  is never touched, so it can stay messy.
- **Nothing to remember.** Every task is saved with its plan, progress, and open questions. Close
  the terminal, come back tomorrow, and ask "where are we?"
- **Code you can trust.** Your project's own checks (tests, types, lint) run on every change, then a
  separate agent that didn't write the code reviews it. Work is only called done when both pass.
  If fixes go three rounds without passing, Tandem stops and asks instead of looping.
- **Costs you control.** You pick a model for each job, so research and review can run on cheaper
  models while coding gets a stronger one. Tandem never switches to a pricier model on its own, and
  it can show what each request cost. When a task finishes and the coordinator's chat has grown
  long, it compacts that chat so later turns don't keep paying for old history.
- **You approve what matters.** Research starts on its own, but code changes, pull requests, and
  merges each wait for your yes. Tandem never merges by itself.
- **Several projects at once.** Open multiple repositories in one session; each gets its own
  coordinator and agents.

## How a request flows

1. **You ask.** Tell the coordinator what you want, for example "add dark mode to the settings
   page".
2. **It plans with you.** The coordinator may send a research agent to read the code first, asks
   about anything unclear, and writes up a short brief: the goal, scope, how success will be
   checked, and what you'll need to check by hand.
3. **You approve.** Nothing is edited until you say yes to the brief. If you change your mind
   later, running work pauses until you approve the new version.
4. **Agents do the work.** A coding agent makes the change in its own worktree. Tandem runs your
   checks, then a separate reviewer looks at the change. Fixes loop until both pass.
5. **You deliver.** When the task is ready, the coordinator offers to open a pull request with a
   summary, the check results, and a checklist of things to verify by hand. Merging is a separate
   approval.

You can watch any agent in its own terminal pane, or chat with it directly.

## Requirements

- macOS (Tandem relies on a macOS file-locking feature; Linux and Windows aren't supported)
- `git` (run `xcode-select --install` if it's missing)
- [Bun](https://bun.com/docs/installation), the JavaScript runtime Tandem runs on
- [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi), the AI coding agent each worker runs,
  already set up with your model provider
- [Herdr](https://herdr.dev/docs/install/), the terminal workspace manager that holds the agent panes
- [Treehouse](https://github.com/kunchenguid/treehouse), which creates the separate worktrees
- Optional: [`gh`](https://cli.github.com/), signed in, for pull requests and merges
- Optional: `lavish-axi`, for visual presentations of work

Tandem uses your existing logins and credentials. It is not a security sandbox: agents run with
your local permissions.

## Install

From a clone of this repository:

```sh
# Bun
curl -fsSL https://bun.com/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Herdr and Treehouse
curl -fsSL https://herdr.dev/install.sh | sh
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh

# OMP
bun install -g @oh-my-pi/pi-coding-agent

# Tandem
bun install
bun link
tandem --help
```

These installers run scripts from the linked projects; read their instructions first if you want
to check what they do. Keep Bun's global bin directory on your `PATH` so `tandem` works from any
folder.

## First run

From inside a repository you want to work on:

```sh
tandem
```

The first time, Tandem looks at the project without changing anything, suggests settings (like
which commands to run as checks), and asks you to pick a model and thinking level for each of its
five roles: **Planning**, **Research**, **Coding**, **Review**, and **Presentations**. You approve
the choices before anything is saved. Model choices apply to all your projects; you can change them
later with `tandem configure`.

Then Tandem opens a Herdr window with the coordinator for that project. Start typing what you want.

To add more projects, pass their paths:

```sh
tandem /path/to/first-repo /path/to/second-repo
```

After that, plain `tandem` from any folder reopens every saved project, and each coordinator
resumes its previous chat. Add `--fresh` to start new chats. Your tasks are kept either way.

## Working with the coordinator

Talk to it in plain language. Some things you can say:

- "Fix the flaky login test."
- "Research how we handle retries before we change anything."
- "What's the status of the dark mode task?"
- "Also make the toggle remember the last choice." (a follow-up for work you already approved)
- "Open a draft PR so I can see progress."
- "Publish it." / "Merge it."
- "Review https://github.com/acme/api/pull/7" (or "skim the idea behind …", or "check the migration in …")

When a worker needs a decision, the coordinator relays the question and a recommendation. It will
answer routine questions itself when your approved plan already settles them, and brings you
anything involving product choices, scope changes, credentials, or publishing.

The coordinator also has a `/tandem` command for direct actions (for example
`/tandem restart TASK_ID` to restart one stuck worker). Type `/tandem` to see the list.

### Working in another repository

Ask for research or a change in another repository ("how does acme/api handle retries?", "add the
field in acme/api too"), and the coordinator runs it from that repository's default branch, found
the same way as for reviews below, without touching your checkout of it. A change that spans
several repositories becomes one task, and one pull request, per repository. If a repository isn't
set up in Tandem, the coordinator asks you how to check work there and adds your answer to the
brief.

### Reviewing a teammate's pull request

Paste a PR link and ask for a review. Tandem finds the repository on your machine (it looks under
`~/Coding/Projects`, or the folders in `TANDEM_PROJECT_ROOTS`, and asks if it can't tell), checks out
the PR in its own worktree without touching your branch, and comes back with what the PR does and
why, the order to read it in, a diagram of the change when it helps, the concerns that matter, and
draft comments written the way a teammate would write them. Bigger reviews open as a page you can
leave notes on.

Tell it what to change ("drop the nit", "make the first one blocking"), ask it questions about the
code, and when you're happy, say whether to comment, approve, or request changes. It posts one
review under your name only after you confirm. When the author pushes again, ask for a re-review:
it looks only at what changed and tells you which of your comments were addressed.

## Terminal commands

| Command | What it does |
| --- | --- |
| `tandem [PATH ...]` | Open or reconnect your projects |
| `tandem status [TASK_ID]` | What's running and what needs you; with a task ID, that task's full history |
| `tandem update` | Load your latest local Tandem code into every coordinator, keeping chats and tasks |
| `tandem fix` | Find and clean up leftovers from a crash or failed launch (asks first) |
| `tandem configure [PATH]` | Change models and project settings |
| `tandem config [PATH]` | Open the project's settings file in your editor |
| `tandem reset` | Cancel all in-progress tasks and reopen fresh coordinators |
| `tandem reset --hard` | Delete all Tandem state and start over |

Common options: `--yes` skips confirmation (`fix`, `reset`), `--json` prints machine-readable
output (`status`, `fix`), and `--home PATH` uses a different Tandem data folder. Run
`tandem --help` for the full list.

## When something goes wrong

Try these in order:

1. **`tandem status`** shows what every task is doing and what needs you. It never changes anything.
2. **A task is stuck:** ask the coordinator to restart it, or run `/tandem restart TASK_ID`. The
   worker keeps its worktree, history, and messages.
3. **A coordinator is misbehaving or you pulled new Tandem code:** `tandem update` replaces the
   coordinators without cancelling any work.
4. **Leftover panes or worktrees after a crash:** `tandem fix` lists what it would clean and asks
   first. Anything with unsaved or unmerged work is kept.
5. **You want a clean slate for tasks:** `tandem reset` cancels in-progress tasks and reopens the
   coordinators. Your files, worktrees, settings, and task history are kept.
6. **You want to start completely over:** `tandem reset --hard` deletes all Tandem data, including
   worktrees with work that was never pushed. It lists everything first and asks.

Don't delete Tandem's files, panes, or worktrees by hand; the commands above check what's safe
before touching anything.

## Where things live

Tandem stores its data in `~/.tandem` (tasks, settings, worktrees), not in your repository. Each
project's settings file, including the check commands, opens with `tandem config`. Your default
data folder and session name are remembered in `~/.config/tandem/config.json`.

## Optional extras

- **Faster answers to simple questions.** With a `TYPESAFE_API_KEY` set, Tandem uses the TypeSafe
  Jev classifier to answer read-only lookups ("list my tasks") instantly without a full model turn.
  A short reply to one of Tandem's fixed-choice questions ("yeah restart it") is answered the same
  way; approving a brief this way still asks you to type `y` first. Anything else that changes
  state goes through the coordinator. See
  [Jev prompt routing](docs/reference/policy.md#jev-prompt-routing).
- **Visual presentations.** With `lavish-axi` installed, the coordinator can produce an HTML page
  explaining a change and collect your feedback on it.
- **Conversational skills.** Three skills let any agent session explain Tandem, onboard a
  repository, or report status. See
  [installing the skills](skills/README.md).

## Learn more

- [Reference](docs/reference/): the behavior contracts behind every command, setting, safety
  check, and recovery rule.
- [AGENTS.md](AGENTS.md): a guide for contributing to Tandem's code.
