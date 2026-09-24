# Tandem

Tandem runs a small team of AI agents on your repository, on your own Mac. You describe what you
want in plain language and approve the plan. Tandem hands the work to agents that research, write
the code, run your checks, and review the result, then asks you before anything is published or
merged.

Tandem also keeps track of every task. You can close the terminal, come back tomorrow, and pick up
where you left off: what's finished, what's still running, and what's waiting on you.

## Why use it

- **You stay in charge.** Research starts on its own, but code changes wait for your approval.
  Publishing a pull request and merging each need a separate yes. Tandem never merges on its own.
- **Your checkout is never touched.** Every agent works in its own clean copy of the repository,
  so your working directory can stay messy.
- **Work is checked twice.** After an agent writes code, Tandem runs your project's own checks
  (tests, types, lint), then a fresh agent that didn't write the code reviews it. If either finds
  a problem, the coding agent fixes it and the checks run again. After three rounds Tandem stops
  and asks whether to keep going.
- **Progress survives restarts.** Tasks, plans, answers, and reports are saved to disk. A crash
  or a closed terminal doesn't lose work.
- **One place to talk.** You chat with one coordinator per project. It plans with you, dispatches
  workers, and brings you only the questions that actually need you.
- **Several projects at once.** Open multiple repositories in one session; each gets its own
  coordinator and workers.

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

When a worker needs a decision, the coordinator relays the question and a recommendation. It will
answer routine questions itself when your approved plan already settles them, and brings you
anything involving product choices, scope changes, credentials, or publishing.

The coordinator also has a `/tandem` command for direct actions (for example
`/tandem restart TASK_ID` to restart one stuck worker). Type `/tandem` to see the list.

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
  Anything that changes state still goes through the coordinator. See
  [Jev prompt routing](docs/agent-reference.md#typesafe-jev-prompt-routing).
- **Visual presentations.** With `lavish-axi` installed, the coordinator can produce an HTML page
  explaining a change and collect your feedback on it.
- **Conversational skills.** Three skills let any agent session explain Tandem, onboard a
  repository, or report status. See
  [installing the skills](docs/agent-reference.md#install-the-global-skills).

## Learn more

- [Agent/operator reference](docs/agent-reference.md): every command, setting, safety check, and
  recovery rule in detail.
- [AGENTS.md](AGENTS.md): a guide for contributing to Tandem's code.
