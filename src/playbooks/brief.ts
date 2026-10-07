import { PLAYBOOKS, type PlaybookId } from "./catalog.ts";
import { stepItem } from "./progress.ts";

/** The implementer brief's playbook section: the numbered steps to load into the to-do list, verbatim. */
export function playbookSection(playbook: PlaybookId): string {
  const { title, steps } = PLAYBOOKS[playbook];
  return [
    `## Playbook: ${title}`,
    "Start by loading these steps into your to-do list with your to-do tool, one item per step, as one phase named Playbook. Copy each line below verbatim as its item's text (its subject), number included, so Tandem can match the item to its step. Give your own items no leading number and put them in other phases. Mark each step done as you finish it.",
    "If a step does not apply, drop it (mark it abandoned) and give the reason in your report. A report with any step still open is rejected.",
    ...steps.map(stepItem),
  ].join("\n");
}
