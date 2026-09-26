---
name: tandem
description: >-
  Explain how to use Tandem in plain language, including the difference between a normal agent
  conversation and a separately requested managed coordinator. Trigger for how-to questions or
  /skill:tandem.
user-invocable: true
---

# tandem

Answer in plain language, from this file alone. A how-to question is a request for an explanation:
answer it, then wait for a separate request before you inspect a repository, onboard, launch, or
change anything.

## What Tandem is

Tandem runs a small team of AI agents on a repository, locally on macOS. The user describes what
they want and approves the plan; Tandem hands the work to agents that research, write the code, run
the project's checks, and review the result, and it asks before anything is published. It
saves every task to disk, so the user can close the terminal and come back later to see what's
finished, what's running, and what needs them.

This conversation is an ordinary agent session. A managed coordinator is a separate Tandem launch
the user starts with the `tandem` command; mentioning Tandem here does not start one.

## How a request flows

1. **Ask.** The user tells the project's coordinator what they want.
2. **Plan.** The coordinator may send a research agent to read the code, asks about anything
   unclear, and writes a short brief: goal, scope, automated checks, and things to check by hand.
3. **Approve.** Code changes wait for the user's yes. Changing the brief later pauses running work
   until it is approved again.
4. **Build, check, review.** A coding agent works in its own clean copy of the repository. Tandem
   runs the project's checks, then a fresh reviewer reads the change. Fixes loop until both pass;
   after three rounds Tandem asks whether to keep going.
5. **Deliver.** Opening a pull request needs its own approval. Once the user publishes it, PR watch
   retries flaky CI and merges it through GitHub auto-merge or the repository's merge queue when
   its checks pass. A draft is never merged.

The user's own checkout is never edited, so it can stay dirty. When a worker needs a decision, the
coordinator relays the question with a recommendation.

## Commands

| Command | What it does |
| --- | --- |
| `tandem` | Open or reconnect every saved project; with none saved, onboard the current repository |
| `tandem PATH ...` | Open or add specific projects |
| `tandem status [TASK_ID]` | What needs the user, what's running, and their pull requests across projects; `--watch` keeps it live; read-only |
| `tandem watch [PR]` | The user's pull requests and what PR watch is doing; with a PR, watch it (`--stop` to stop) |
| `tandem update` | Reload every coordinator with the latest local Tandem code, keeping chats and tasks |
| `tandem fix` | Find leftovers from a crash or failed launch and offer to clean them (asks first) |
| `tandem configure [PATH]` | Change the model for each role |
| `tandem config [PATH]` | Open the project's settings file in an editor |
| `tandem reset` | Cancel all in-progress tasks and reopen fresh coordinators; files, worktrees, settings, and history stay |
| `tandem reset --hard` | Delete all Tandem data, including unpushed worktrees; mention only when the user wants to start over |

Chats resume by default; `--fresh` starts new ones. Inside a coordinator, `/tandem restart TASK_ID`
restarts one stuck worker without losing its work.

## Onboarding

On first run Tandem inspects the project without changing it, proposes settings such as check
commands, and asks the user to choose a model and thinking level for each of five roles:
**Planning**, **Research**, **Coding**, **Review**, and **Presentations**. Nothing is saved until the
user approves the full recap. Model choices apply to all projects and take effect on the next launch.

## Faster answers with Jev

With `TYPESAFE_API_KEY` in the shell profile, Tandem answers simple lookups without waking the
coordinator model. It is on by default; onboarding and `tandem configure` show whether a key is set
and let the user turn it off. A company Portkey gateway also needs `PORTKEY_BASE_URL`, `PORTKEY_API_KEY`,
`PORTKEY_PROVIDER`, `PORTKEY_CUSTOM_HOST`, and `PORTKEY_JEV_MODEL` (details in
`docs/reference/policy.md`). Never ask for or handle a key: show the `export` lines and have the
user paste their keys into the profile themselves. Ask for the other values; never guess them.
Relaunch Tandem from a new terminal afterward. A wrong value just skips Jev.

## Starter requests

- "How do I use Tandem?": explain the flow above.
- "Onboard `/path/to/repo`.": use `tandem-onboard`.
- "What's the state of my Tandem tasks?": use `tandem-status`.
- "Launch Tandem for `/path/to/repo`.": run `tandem /path/to/repo` once the user asks for it.

For every setting and safety rule, see `docs/reference/` in the Tandem checkout.
