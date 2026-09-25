import { PLAYBOOKS, type PlaybookId } from "./catalog.ts";

/** The implementer brief's playbook section: the steps to load into the to-do list, verbatim. */
export function playbookSection(playbook: PlaybookId): string {
  const { title, steps } = PLAYBOOKS[playbook];
  return [
    `## Playbook: ${title}`,
    "Start by loading these steps into your to-do list with the todo tool, word for word, as one phase named Playbook. Add your own steps in other phases. Mark each step done as you finish it.",
    "If a step does not apply, drop it (mark it abandoned) and give the reason in your report. A report with any step still open is rejected.",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}
