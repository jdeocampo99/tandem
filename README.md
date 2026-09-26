# Tandem

Tandem is an agent orchestrator and toolkit for your agents that handles the tedious parts of building with coding agents. You chat with one agent about what
you want, and Tandem takes it from idea to merged pull request: it researches the code, agrees on a
plan with you, writes the change, tests and reviews it, opens the pull request, and sees it through
CI and review. Every task is saved, so you can close the terminal and pick up where you left off.

The parts it takes off your plate:

- **Slop.** Agents pad their writing and cut corners in code. Tandem holds every agent to shared
  writing and code standards and a playbook for its kind of task, then has a fresh reviewer grade
  the work against the same rules.
- **Context windows and worktrees.** Each job gets a fresh agent with only the context it needs, in
  its own worktree that Tandem creates, reuses, and cleans up. Your own checkout is never touched.
- **Managing agents.** Tandem manages delegating research, coding, and review agents,
  which run on each on the model you picked for its role so research can use a cheaper one,
  remembers where every task stands, and brings you only the questions that need you.
- **Pull requests.** It opens them, carries them through flaky CI, conflicts, and merge queues, and
  helps you review your teammates's code with an interactive view and interface to visually understand their code and leave comments.

The orchestration behind all of this is deterministic code, and a small classifier answers routine
questions, so **model tokens go only to the work that needs judgment**.

## What it does

### Orchestration in code

![How a request moves through Tandem: the model researches, plans, implements, and reviews; you approve and publish; code validates, opens the draft PR, and runs PR watch](docs/images/request-flow.svg)

Models do the judgment work: researching, planning, writing code, and reviewing it. Everything
around them is ordinary TypeScript: task stages, scheduling, worktree allocation, approvals,
validation, retries, recovery, and pull request decisions. Validation runs your project's checks
with no model involved. PR watch decides what to do from a fixed decision table.

Keeping orchestration out of the model makes Tandem **faster and cheaper, since no tokens go to
bookkeeping**, and predictable, since the same state always leads to the same next step.

### Guardrails against slop

Models tend to over-explain, pad, and reach for the same handful of phrases. Tandem holds **every
agent to a shared writing standard** that bans the usual tells (preambles, closing summaries, "not
X, it's Y", filler words like "robust" and "leverage") across chat replies, code comments, docs,
commit messages, and pull request text. Briefs have hard limits on list length and item size.

The same goes for code. Implementers write to a set of code standards (honest signatures, one level
of abstraction per function, reuse before adding, plain names, comments that explain why) and
**reviewers grade against the identical text**. A project that has its own conventions can turn these
off with `standards = "none"`.

### Playbooks

Every coding task follows a playbook for its kind of work, so **good practice happens by default on
every task**. Tandem picks the playbook, and the agent can't finish until each step is done or it
explains why one doesn't apply.

| Playbook | Main steps |
| --- | --- |
| Bug fix | Reproduce it in a failing test, fix the cause, commit the test before the fix |
| Feature | Reuse existing code, test through the public entry point, check reruns and partial failures |
| Refactor | Confirm coverage first, move every caller, delete the old version |
| Perf | Measure before and after, fix the cause |
| Fix round | Fix every finding, confirm each is gone |

### Validation and independent review

Every change runs your project's tests, types, and lint first. Then **a fresh reviewer agent that
didn't write the code** reads it through three lenses:

- **Behavior:** does it do what the approved brief says, including errors, edge cases, ordering,
  and security.
- **Design:** every changed function and its callers, graded against the same code standards and
  principles the implementer followed.
- **Coverage:** whether the changed behavior is tested, based on evidence in the diff.

Each finding has to cite evidence. Findings go back to the implementer as a fix round, and the next
review focuses on what changed since. After two fix rounds without a clean pass, Tandem stops and
asks you whether to keep going.

### Watching pull requests until they merge

A ready task opens a draft pull request with a summary, check results, and a checklist of anything
to verify by hand. From there PR watch **keeps it moving and only brings you the cases that need a
person**. Hand it any other pull request with `tandem watch <link>`.

![How PR watch keeps a pull request moving: it fixes flaky checks, conflicts, stale branches, and queue kick-outs on its own, merges when everything is green, and comes to you only when a person is needed](docs/images/pr-watch.svg)

### Reviewing other people's pull requests

Paste a PR link and ask for a review. Tandem checks it out in its own worktree and comes back with
what the change does, the order to read it in, the concerns that matter, and draft comments in a
teammate's voice. Edit them in conversation, then say whether to comment, approve, or request
changes. Nothing posts until you confirm. A re-review looks only at what changed since and tells
you which comments were addressed.

### Jev routing

Tandem uses [TypeSafe's Jev](docs/reference/policy.md#jev-prompt-routing), a small, fast
classifier, to handle the parts of a conversation that **don't need a full model turn**. Jev input
costs $0.042 per million tokens with output free.

![How Jev routes a prompt: a confident match runs in code with no model turn, anything else goes to the coordinator](docs/images/jev-routing.svg)

- Lookups like "how's it going?", "how are my PRs?", or "list my tasks" are answered instantly.
- Short replies to Tandem's own questions ("yeah restart it") run directly. Approving a brief this
  way still asks you to type `y`.
- "Pull up the dark mode brief" and "why did that task take so long?" go straight to the right
  action.
- Each coding task's playbook is picked by Jev.

Jev only chooses among options Tandem's code lists for it. It never authorizes anything, and any
low-confidence or unclear prompt falls through to the coordinator. Without a `TYPESAFE_API_KEY`,
everything goes to the coordinator and tasks use the General playbook.

### Visual mockups

With [Lavish](https://github.com/kunchenguid/lavish-axi) installed, a research agent can draw a
mockup, wireframe, or explainer page and open it in your browser. Comment on the page and **your
comment goes straight back to the agent**, which updates the page while the tab reloads. The agent
stays open after its research, so you can settle on a design before any code is written.

### Cost control

You pick a model and thinking level for each role (planning, research, coding, review,
presentations), so research can run on a cheaper model while coding and review get stronger ones.
**Tandem never switches to a pricier model on its own.** Each request records its usage and cost, and
the coordinator's chat is compacted after a task finishes so later turns don't pay for old history.

### Everything else

- **Approvals where they matter.** Research starts on its own. Code changes wait for you to approve
  a short brief, and publishing waits for another yes.
- **Several projects and repositories.** Open multiple projects in one session. Ask for work in
  another repository and Tandem runs it there without touching your checkout, one pull request
  per repository.
- **Skills.** `/skill:tdd fix the retry bug` gives the worker and its reviewer the whole skill.
- **Self-improvement.** When a task restarts twice or gets stuck, Tandem can investigate its own
  source and propose a fix, or draft a scrubbed GitHub issue on machines that shouldn't push code.

## One view of everything

`tandem status` shows every project at once: what needs you, what's running, and your pull
requests. `tandem status --watch` keeps it live, and the coordinator opens it beside the chat when
something new waits on you.

```
Projects: tandem, tagalingo · PRs checked 40s ago

Needs you
🙋 tandem     Dark mode                    brief waiting for approval
🔴 tagalingo  acme/app#409 refactor-cache  🙋 test_cache_evict failed twice → https://ci/…

Running
🔨 tandem     Fix the flaky login  implementing · 12m

PRs
🟢 acme/app#420 add-cache ⏳ 12/16 ✅ approved

This week: 7 done · 5 of 7 passed review first time · $14.20
```

## Requirements

- macOS
- `git`
- [Bun](https://bun.com/docs/installation)
- [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi), set up with your model provider
- [Herdr](https://herdr.dev/docs/install/), which holds the agent panes
- [Treehouse](https://github.com/kunchenguid/treehouse), which creates worktrees
- Optional: [`gh`](https://cli.github.com/), signed in, for pull requests and PR watch
- Optional: `lavish-axi` for presentations, `TYPESAFE_API_KEY` for Jev

Agents run with your local permissions. Tandem is not a security sandbox.

## Install and first run

From a clone of this repository:

```sh
./setup.sh
```

It installs whatever is missing (read [setup.sh](setup.sh) first if you want to check) and is safe
to run again. Keep Bun's global bin directory on your `PATH`.

Then, from inside a repository:

```sh
tandem
```

The first run looks at the project without changing anything, suggests check commands, and asks you
to choose models for each role. After that, plain `tandem` from any folder reopens every saved
project with its previous chat. Add more with `tandem /path/to/repo`.

## Commands

| Command | What it does |
| --- | --- |
| `tandem [PATH ...]` | Open or reconnect your projects |
| `tandem status [TASK_ID]` | What needs you, what's running, and your pull requests; with a task ID, that task's history |
| `tandem trace [TASK_ID]` | What happened to a task and why, with review, fix-round, blocked-time, and cost figures |
| `tandem watch [PR]` | Your watched pull requests; with a link or number, start watching it (`--stop` to stop) |
| `tandem update` | Load your latest local Tandem code into every coordinator, keeping chats and tasks |
| `tandem fix` | Clean up leftovers from a crash or failed launch (asks first) |
| `tandem configure [PATH]` | Change models and project settings |
| `tandem config [PATH]` | Open the project's settings file |
| `tandem reset` | Cancel all in-progress tasks and reopen fresh coordinators |
| `tandem reset --hard` | Delete all Tandem state and start over |

Run `tandem --help` for options.

## When something goes wrong

Start with `tandem status`, then `tandem trace TASK_ID` to see why a task stalled. Ask the
coordinator to restart a stuck task; it keeps its worktree and history. `tandem update` replaces a
misbehaving coordinator without cancelling work, and `tandem fix` cleans up after a crash. Don't
delete Tandem's files, panes, or worktrees by hand.

Tandem keeps its data in `~/.tandem`, never in your repository.

## Credits

Tandem's playbooks and the principles its coding and review agents follow are adapted from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). Worktrees come from
[Treehouse](https://github.com/kunchenguid/treehouse) and visual mockups from
[Lavish](https://github.com/kunchenguid/lavish-axi), both by Kun Chen.

## Learn more

- [Reference](docs/reference/): the behavior behind every command, setting, and safety check.
- [AGENTS.md](AGENTS.md): contributing to Tandem.
- [Skills](skills/README.md): let any agent session explain Tandem, onboard a repository, or
  report status.
