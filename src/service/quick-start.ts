import type { QuickTaskApproval, TaskRecord } from "../contracts.ts";
import { checkQuickText, quickStartedText } from "../tasks/quick.ts";
import type { StartQuickTaskInput, TandemService } from "./controller.ts";

/** What starting a quick task did: the task always exists; `told` says whether the coordinator knows. */
export type QuickStarted =
  | Readonly<{ task: TaskRecord; told: true }>
  | Readonly<{ task: TaskRecord; told: false; problem: string }>;

/**
 * The one way a quick task starts, from the native Start click: check the text without a model,
 * record the user's approval and create and approve the task, then tell the coordinator in fixed
 * words. `tell` proves the coordinator before it types; a failure there is
 * reported, never retried, because the task already started.
 */
export async function startQuickTask(
  service: Pick<TandemService, "startQuickTask">,
  input: StartQuickTaskInput,
  tell: (text: string) => Promise<void>,
): Promise<QuickStarted> {
  const checked = checkQuickText(input.text);
  if (!checked.ok) throw new Error(checked.problem);
  const task = await service.startQuickTask({ ...input, text: checked.text });
  const approval: QuickTaskApproval | undefined = task.quick;
  if (approval === undefined) throw new Error(`Task ${task.id} did not record its quick approval`);
  try {
    await tell(quickStartedText(task, approval));
    return { task, told: true };
  } catch (error) {
    return { task, told: false, problem: error instanceof Error ? error.message : String(error) };
  }
}
