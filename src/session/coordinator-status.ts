import type { TaskRecord } from "../contracts.ts";
import { isMissing, isTerminalTask } from "../service/records.ts";
import { fixRoundBudget, ledgerBlockers } from "../tasks/findings.ts";
import { recordedReviewLevel } from "../tasks/review-levels.ts";
import type { AgentState, AgentStatusReporter } from "../terminal-backend/contract.ts";
import type { ToolCall } from "./events.ts";

/** Status-line summary of an in-progress review cycle, or `undefined` outside one. */
export function reviewStatus(task: TaskRecord): string | undefined {
  if (task.stage !== "reviewing" && task.stage !== "awaiting-fixes") return undefined;
  const current = task.reviews.filter(
    (review) => review.head === task.reviewHead && review.generation === task.generation,
  );
  const failed = current.filter((review) => !review.pass).map((review) => review.lens);
  const blockers = ledgerBlockers(task.findingLedger ?? [], recordedReviewLevel(task).level).length;
  const parts = [
    task.reviewRound === 0
      ? task.stage
      : `${task.stage} fix ${task.reviewRound}/${fixRoundBudget(task)}`,
  ];
  if (failed.length > 0) parts.push(`${failed.join(",")} fail`);
  if (blockers > 0) parts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Whether a path is this already-resolved repository; a missing checkout is not. */
export async function isInRepository(
  repoPath: string,
  repo: string,
  realpath: (path: string) => Promise<string>,
): Promise<boolean> {
  if (repoPath === repo) return true;
  const resolved = await realpath(repoPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  return resolved === repo;
}

type TaskStatus = Readonly<{ state: AgentState; message: string | undefined }>;

/**
 * The coordinator pane's task status: the first open task in this repository waiting on someone,
 * otherwise the last one working, otherwise idle.
 */
async function coordinatorTaskStatus(
  tasks: readonly TaskRecord[],
  repo: string,
  realpath: (path: string) => Promise<string>,
): Promise<TaskStatus> {
  let status: TaskStatus = { state: "idle", message: undefined };
  for (const task of tasks) {
    if (isTerminalTask(task) || task.stage === "ready") continue;
    if (!(await isInRepository(task.repoPath, repo, realpath))) continue;
    if (task.stage === "blocked" || task.stage === "paused" || task.stage === "awaiting-approval") {
      return { state: "blocked", message: task.blockReason ?? `${task.stage}: ${task.objective}` };
    }
    status = {
      state: "working",
      message: reviewStatus(task) ?? `${task.stage}: ${task.objective}`,
    };
  }
  return status;
}

/** The Herdr status of the coordinator pane: waiting for an answer, working, or its tasks' state. */
export class CoordinatorStatus {
  agentActive: boolean = false;
  private taskState: AgentState = "idle";
  private taskMessage: string | undefined;
  private readonly waitingInputs = new Set<string>();

  constructor(readonly reporter: AgentStatusReporter | undefined) {}

  get waitingForInput(): boolean {
    return this.waitingInputs.size > 0;
  }

  report(): void {
    if (this.waitingInputs.size > 0) {
      void this.reporter?.report("blocked", "Waiting for your answer");
    } else if (this.agentActive) {
      void this.reporter?.report("working", this.taskMessage);
    } else {
      void this.reporter?.report(this.taskState, this.taskMessage);
    }
  }

  async updateTasks(
    tasks: readonly TaskRecord[],
    repo: string,
    owner: Readonly<{ realpath(path: string): Promise<string> }>,
  ): Promise<void> {
    if (this.reporter === undefined) return;
    const resolved = await owner.realpath(repo);
    this.setTasks(await coordinatorTaskStatus(tasks, resolved, owner.realpath));
    this.report();
  }

  private setTasks(status: TaskStatus): void {
    this.taskState = status.state;
    this.taskMessage = status.message;
  }

  block(message: string): void {
    this.setTasks({ state: "blocked", message });
  }

  toolStarted(call: ToolCall): void {
    this.agentActive = true;
    if (call.kind === "ask") this.waitingInputs.add(call.id);
    this.report();
  }

  toolEnded(call: ToolCall): void {
    this.waitingInputs.delete(call.id);
    this.report();
  }
}
