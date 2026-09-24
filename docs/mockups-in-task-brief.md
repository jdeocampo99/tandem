# Brief: mockups live in the task that asked for them

## Goal

Make iterating on a mockup feel like a conversation with one agent. The research agent that
understands the problem draws the mockup, Lavish opens next to it, and what you type in Lavish goes
straight to that agent and gets acted on.

## How it works

- You start a research task. It gets a worktree, a pane and its own conversation, as it does today.
- When a mockup would help, that same agent writes the HTML, and Lavish opens in a pane next to it.
- When you hit Enter in Lavish, your input goes straight to that agent, like a steer. It edits the
  same file and the same tab reloads. The coordinator only gets a one-line "revising mockup."
- When you say "build it," the implementation task starts in its own worktree with the research
  report and the final mockup attached.

## Why

A session from 2026-09-24 (TAG-1039 cancellation mockup): from the user's Lavish comment "add a sad
JR" to the coordinator giving up took 23 minutes and 3 extra agents, and no revised mockup came
out of it.

- The feedback woke the coordinator, which treated it as an observation, summarized it and waited.
- "ok lets add the jr thing" got steered to the research task, which spent about 10 minutes working
  out which screens were meant.
- The revision started a fresh presenter with no memory of v1, a new artifact, and a new tab.
- The presenter couldn't copy the animated `jr-thinking.webp` (it has no shell), so the coordinator
  started a research task, and with it a new worktree, just to read one file. Then it gave up.

## Scope

1. **Research agents can write their mockup file.**
   - Scouts gain `write` and `edit`, allowed only on the task's artifact path. Everything else stays
     read-only (`SCOUT_TOOLS`, src/worker.ts).
   - The artifact stays outside the repo checkout (`<home>/presentations/<id>/`), so it never lands
     in a diff or dirties the worktree.
   - Mockup edits must still be allowed after the scout completes. Today follow-up turns after
     completion block mutating tools (docs/reference/task-lifecycle.md, "Interactive child
     terminals"); the artifact path gets an exception.
   - The coordinator's `present` action asks the owning task's agent to make the mockup in its own
     conversation instead of launching a separate presentation worker.
2. **Lavish feedback goes to the task that owns the mockup.**
   - The feedback listener (src/presentations/feedback.ts) turns each Lavish prompt into the owning
     scout's next turn (a `mockup` terminal command, delivered once the scout is idle), and that
     agent acts on it right away.
   - The coordinator gets a one-line notification ("revising mockup: add sad JR"), not a turn to
     decide.
   - Revisions edit the same `artifact.html`. Lavish keeps one session per mockup, and the same tab
     reloads.
3. **The agent can put a repo image into the mockup.**
   - Lavish serves files that sit next to the HTML via relative paths. A small `copy_asset` tool
     copies a file from the task's worktree into the artifact directory, byte for byte.
   - It refuses paths outside the worktree and destinations outside the artifact directory.
4. **Remove the separate presentation role.**
   - Delete the presentation worker's job/launch path. Keep the Lavish controller (open, listener,
     reopen) and presentation records, now owned by the task.
   - Follow-up: remove the leftover `presentation` model setting (onboarding, saved settings,
     pinned task policies), which needs legacy decoding of existing settings and task records.
5. **Keep the research agent alive.**
   - A finished scout whose research leads to implementation keeps its pane and worktree, so it can
     draw and revise after its report. Its pane closes when the implementation that follows starts
     (which then adopts the worktree) or when the task is cancelled. Report-only research closes as
     before.

## Constraints

- "Feedback is not approval" still holds for app code, PRs, publishing and merging. It no longer
  applies to edits of the mockup file itself (update docs/reference/delivery.md and
  operating-model.md).
- The controller still owns Lavish: opening it, the listener, reopening, and never reopening a
  session the user ended.
- Mockup style rules (src/presentations/mockup-style.md) still reach the agent when it draws.
- The research report is unchanged by mockup edits. The report and the latest mockup are both
  handed to implementation.

## Non-goals

- Hitting Enter in Lavish does not start implementing app code. "Build it" stays one explicit step.
- No change to how implementation, validation, review or delivery work.
- Mockups during implementation tasks. Only research tasks make mockups. The coding agent is paused
  while checks and review run, so its Lavish feedback would have to wait; revisit if needed.
- PR-review pages (fixed template, src/pr-review/) are unchanged.

## Acceptance criteria

- A mockup requested on a scout task is written by that scout's conversation. The presentation
  worker role no longer exists.
- A Lavish prompt reaches the owning agent as an instruction and triggers an edit without a
  coordinator turn. The coordinator gets one short notification per prompt.
- Revisions overwrite the same artifact and reuse the same Lavish session and tab.
- Mockup edits still work after the scout has completed, and the scout's pane stays open after a
  report that leads to implementation.
- The scout cannot write outside its artifact folder, before or after completion.
- `copy_asset` copies a binary image (for example animated WebP) byte for byte into the artifact
  directory, and the mockup renders it via a relative path. It refuses paths outside the worktree or
  the artifact directory.
- No new worktree or task is created by a mockup revision.
- Delivery, operating-model and task-lifecycle docs describe the new flow.

## Manual verification

- Start a research task, ask for a mockup, and comment in Lavish. The same tab updates with the
  change without you going back to the coordinator.
- Ask for a repo image in the mockup, and it shows up.
