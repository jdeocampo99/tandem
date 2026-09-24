---
name: tandem-status
description: >-
  Tell the user, in plain English, what their Tandem tasks are doing and what to do when one seems
  stuck. Trigger on status or progress questions, "why is my task stuck", "Tandem is acting weird",
  or /skill:tandem-status.
user-invocable: true
---

# tandem-status

This skill reads Tandem's saved state and explains it. It only reads: when a fix is needed, it
recommends one command for the user to run.

Pick the branch:

- **Overview**: "what's going on?", "how are my tasks?" Go to [Overview](#overview).
- **Stuck**: a task seems stuck, failed, or blocked, or Tandem is acting strangely. Go to
  [Stuck](#stuck).

## Talk like a teammate

Every reply is for someone who doesn't know Tandem's internals.

- Describe each task by what it's for (its objective), not its ID. Add the ID only when the user
  needs to type it.
- Use the plain words in the table below for stages. Leave out internal terms such as generation,
  lease, reservation, endpoint, HEAD, or quarantine.
- Lead with what needs the user, then what's running, then what's done.
- Say "Tandem's records show" rather than claiming something is running right now; the records
  can't prove a process is alive.
- Keep it to a few short bullets. Offer detail if they want it.

| Stage | Say |
| --- | --- |
| `awaiting-approval` | waiting for your OK on the plan |
| `queued` | waiting its turn to start |
| `scouting` | researching |
| `implementing` | writing code |
| `validating` | running your project's checks |
| `reviewing` | being reviewed by a fresh agent |
| `awaiting-fixes` | checks or review found problems; a fix round is next |
| `ready` | finished and checked, waiting for you to decide on a pull request (nothing published yet) |
| `paused` | paused |
| `blocked` | stopped and needs attention (explain why, see [Stuck](#stuck)) |
| `completed` | research finished (mention the report) |
| `merged` | merged |
| `cancelled` | cancelled |

## Find Tandem's data

Use the installed `tandem` command. The data folder ("home") is, in order: `--home` if the user
gave one, `TANDEM_HOME`, the `home` in `$XDG_CONFIG_HOME/tandem/config.json` (default
`~/.config/tandem/config.json`), then `~/.tandem`. If `<home>/state.sqlite` doesn't exist, say in one
sentence that Tandem has no saved tasks there, and stop.

For "this project", resolve the current folder to its Git top-level path. When the user says "all
projects", skip that.

## Overview

Run once, capturing errors:

```sh
set -o pipefail
tandem status --home "<home>" --json |
  jq --arg repo "<project-root or empty for all>" '.tasks | map(select($repo == "" or .repoPath == $repo)
    | {id, objective, stage, blockReason, blockCause, reportPath, pullRequest, updatedAt})'
```

If it fails or the output isn't JSON, say so and show the error; don't retry with other commands.
Otherwise reply in three
to five bullets following [Talk like a teammate](#talk-like-a-teammate). No tasks means one sentence.
If any task is `blocked`, name the reason in plain words and offer to look into it.

## Stuck

1. Find the task. If the user didn't name one, run the overview read and pick the task that's
   `blocked` or has sat in one stage unusually long; ask if more than one fits.
2. Read it once:

   ```sh
   tandem status TASK_ID --home "<home>" --json
   ```

3. Work out which case applies, using `stage`, `blockCause` (its `group` and plain `summary`),
   `blockReason`, `codeFixRounds`, and whether its worker `endpoints` are `alive`.
4. Reply with: what happened (one or two sentences, using `blockCause.summary` when present),
   whether their work is safe (task worktrees are always kept), and **one** recommended next step.
   Leave the step for the user to run.

| What you see | Plain explanation | Recommend |
| --- | --- | --- |
| Blocked, `group` is `lost-resource` or `unusable-result` | Something the worker relied on broke (a crash, a lost terminal, a result it couldn't use). Tandem retries these on its own, up to twice. | Wait for the automatic retry; if it already used both, ask the coordinator to restart the task, or type `/tandem restart TASK_ID` in the coordinator. |
| Blocked, `fix-rounds-exhausted` | The fixes went three rounds without passing, so Tandem stopped to ask. | Answer "Keep fixing?" in the coordinator: yes for another round, no to stop. |
| Blocked, `validation-config-refused` | The project's check commands don't cover this change or can't run. | Open the settings with `tandem config` and fix the check commands, then restart the task. |
| Blocked, `prerequisite-not-met` or `explicit-block` | Tandem is waiting on something only the user can decide. | Quote the question from `summary` or `blockReason` and tell them to answer it in the coordinator. |
| Blocked, `group` is `safety-stop` | Tandem couldn't confirm it was safe to touch something, so it stopped instead of guessing. | Run `tandem fix` to see what it found (it asks before changing anything). If the task stays blocked, share this status output. |
| Blocked, no `blockCause` | Explain `blockReason` in plain words. | Pick the closest row above. |
| Active stage, worker endpoint `alive` | It's still working. | Watch it in its Herdr pane; nothing to fix. |
| Active stage, worker endpoint `stopped` or `missing` | The worker's terminal is gone, but the task still says it's working. | Ask the coordinator to restart the task, or `/tandem restart TASK_ID`. |
| `queued` for a long time | Other tasks are using all the worker slots. | Wait, or cancel a task they no longer need. |
| The coordinator itself misbehaves | Its code or chat is in a bad state. | `tandem update` (keeps chats and tasks). |
| Leftover panes or worktrees after a crash | Something wasn't cleaned up. | `tandem fix`. |

Stronger options exist: `tandem reset` cancels every in-progress task, and `tandem reset --hard`
deletes all Tandem data. Mention them only when the user asks to start over, and say what each
loses.
