function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One to-do item as OMP's `todo` tool reports it. */
export type TodoItem = Readonly<{ readonly content: string; readonly status: string }>;

/**
 * The to-do list a `todo` tool result carries. Every result, even a rejected op, reports the list
 * as it now stands, so the latest one is the current state. Anything else yields undefined.
 */
export function todoItems(result: unknown): readonly TodoItem[] | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const phases = result.details.phases;
  if (!Array.isArray(phases)) return undefined;
  const items: TodoItem[] = [];
  for (const phase of phases) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) return undefined;
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || typeof task.status !== "string")
        return undefined;
      items.push({ content: task.content, status: task.status });
    }
  }
  return items;
}

/** A step's to-do item as the brief asks for it: its number, then its text verbatim. */
export function stepItem(step: string, index: number): string {
  return `${index + 1}. ${step}`;
}

const NUMBER_PREFIX = /^(?:step\s*)?(\d+)\s*[.):-]\s*/i;

function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// A numbered item ("2. Reuse check") stands for the step with that number, whatever its wording,
// since Claude Code workers paraphrase task subjects. An unnumbered item stands for the step whose
// text it matches, ignoring case, spacing and punctuation.
function standsFor(content: string, step: string, index: number): boolean {
  const trimmed = content.trim();
  const numbered = NUMBER_PREFIX.exec(trimmed);
  if (numbered !== null) return Number(numbered[1]) === index + 1;
  return comparable(trimmed) === comparable(step);
}

function closed(item: TodoItem): boolean {
  return item.status === "completed" || item.status === "abandoned";
}

/**
 * Playbook steps not yet completed or abandoned, each as its numbered to-do item text. A step
 * missing from the list is open too, so removing it is not a way to skip it.
 */
export function openSteps(
  steps: readonly string[],
  items: readonly TodoItem[] | undefined,
): readonly string[] {
  const open: string[] = [];
  steps.forEach((step, index) => {
    const done = (items ?? []).some((item) => closed(item) && standsFor(item.content, step, index));
    if (!done) open.push(stepItem(step, index));
  });
  return open;
}

/** Why an `implemented` report waits: the open steps, quoted as the items that would close them. */
export function openStepsRejection(open: readonly string[]): string {
  const quoted = open.map((item) => `"${item}"`).join("; ");
  return `these playbook steps are still open in your to-do list: ${quoted}. Finish them, or drop any that do not apply with your to-do tool and give the reason in your report. Name each step's to-do item exactly as quoted, number included, so Tandem can tell which step it is`;
}
