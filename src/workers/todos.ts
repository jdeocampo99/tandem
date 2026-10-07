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

/**
 * Required steps not yet completed or abandoned. A step missing from the list is open too, so
 * removing it is not a way to skip it.
 */
export function openSteps(
  steps: readonly string[],
  items: readonly TodoItem[] | undefined,
): readonly string[] {
  return steps.filter((step) => {
    const item = items?.find((entry) => entry.content.trim() === step);
    return item?.status !== "completed" && item?.status !== "abandoned";
  });
}
