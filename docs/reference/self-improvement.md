# Self-improvement

What Tandem guarantees when it looks into its own problems: when it asks, what the research reads,
where a fix goes, and what a report-mode issue may contain before it is filed.

Code: src/self-improvement/ (`triggers.ts` the rules, `issue-draft.ts` the scrub and Jev check,
`service.ts` questions, investigations, and filing), src/config/home-settings.ts
(`selfImprovement`), src/session/notifications.ts (`deliverInvestigationQuestions`),
src/session/investigate-route.ts, src/session/actions.ts (`investigate`, `report-issue`).

## Modes

`selfImprovement` in `<home>/settings.toml`, read live on each use:

| Mode | After an investigation |
| --- | --- |
| `off` (default) | Nothing asks, the on-demand route stays out of the way, and `investigate` and `report-issue` refuse with how to turn it on. |
| `fix` | The research ends by asking whether to fix it. A yes is a normal task in the Tandem repository: brief, approval, implement, review, draft pull request. `tandem update` reloads coordinators once it merges. |
| `report` | The research ends with a draft GitHub issue. The coordinator files it through `report-issue` only after the user approves it. |

The mode is set by hand only. Tandem never infers it from GitHub push rights: the same account can
push from a machine whose company policy forbids it.

## Triggers

Fixed rules over the task's timeline, never a model's judgement (`investigationTrigger`):

- 2 or more `restarted` events;
- 3 or more `fix-round` events;
- one block, from `blocked` to the next `unblocked` or to now, longer than one hour.

Each coordinator tick checks its own open tasks (not completed, cancelled, or merged) while the
mode is not `off`. The first rule a task breaks produces one plain question ("... has restarted
twice. Want me to look into why?"), shown without a model turn, with the task in a hidden line. The
task id is recorded under `self_improvement_asked` in the metadata table in the same transaction,
so each task is asked about once per home, even with several coordinators open. On yes the
coordinator calls `investigate`; on no nothing happens.

Recurring finding categories are not triggers yet; they come with the #189 rollups.

## Investigations

`investigate` takes the task and, when the user asked, their question. It:

1. writes the task's record and timeline to `<home>/investigations/<taskId>.json`, the events
   `tandem trace TASK_ID --json` prints, because research agents read files but run no commands;
2. creates a research task under the task's own project with `targetRepo: jdeocampo99/tandem`,
   or without a target when that project is the Tandem checkout;
3. points the objective at that file, the task's conversations (`<home>/sessions/<taskId>`), its job
   files and reports (`<home>/jobs/<taskId>`), and Tandem's source in the research checkout.

The post-research follow-up is pinned: `ask-intent` in `fix` mode, `report-only` in `report` mode,
where the objective also asks for a `## Draft issue` section. It is an ordinary research task: no
new agent type, and finding the Tandem checkout follows [other-repositories.md](other-repositories.md)
(`targetCheckout` or `targetClone` when it cannot be found).

## On demand

With the mode on and Jev configured, a prompt with "why" and a word about task trouble goes to one
Jev call listing the 15 most recently changed tasks (see
[Jev prompt routing](policy.md#jev-prompt-routing)). A confident `investigate` answer naming one
task starts the investigation in code with the prompt as its question. `other`, low confidence, a
provider failure, or an unreadable task list continue to the other routes and the coordinator.

## Report-mode issues

`report-issue` takes the investigated task and the draft's title and body. It needs the user's
approval, and its approval dialog is the only place the draft becomes final:

1. **Scrub** (`scrubIssueDraft`, deterministic): fenced code blocks, local paths starting at `/` or
   `~` (URLs stay), token-shaped secrets, sentences of the task's objective, acceptance criteria,
   manual checks, and block reason, and the names of its project and target repository. Tandem's
   own name and relative Tandem source paths stay.
2. **Check**: one Jev call asks whether the scrubbed draft still holds work code, paths, names,
   task text, or secrets. Only a confident `clean` (0.80 or more) passes. A flag, a failure, a
   timeout, a missing key, or a draft over 12,000 characters counts as flagged.
3. **Approve**: the dialog shows the scrubbed title and body, with the warning first when flagged.
   No, or no dialog, files nothing. To edit, the user says what to change and the coordinator calls
   `report-issue` again, which scrubs and checks the new text.
4. **File**: `gh issue create --repo jdeocampo99/tandem` with the same scrubbed text; the scrub is
   deterministic, so what is filed is what the dialog showed.

The check uses the existing Jev client, so with `PORTKEY_BASE_URL` set it goes through the Portkey
gateway like every other Jev call. It sends only the scrubbed draft. Whether a work machine's policy
allows sending even that through the gateway is the user's call before turning `report` on.
