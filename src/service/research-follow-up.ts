import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskRecord } from "../contracts.ts";
import type { PresentationAgent } from "../presentations/records.ts";
import { presentationRequestStep } from "../presentations/workflow.ts";
import type {
  WorkerMockupRequest,
  WorkerTerminalJob,
  WorkerTerminalState,
} from "../workers/terminal.ts";
import { scoutLeadsToImplementation } from "./scout-cleanup.ts";

const ANSWER_WAIT_MS = 120_000;
const ANSWER_POLL_MS = 1_000;
const REQUEST_ACK_TIMEOUT_MS = 3_000;

/** Why the research agent can't take a follow-up question now; `undefined` when it can. */
export function researchFollowUpRefusal(
  task: Pick<TaskRecord, "id" | "kind" | "stage" | "researchContinuation">,
  terminal: WorkerTerminalState | undefined,
  nowMs: number,
): string | undefined {
  if (task.kind !== "scout" || task.stage !== "completed") {
    return `Task ${task.id} is not completed research.`;
  }
  if (!scoutLeadsToImplementation(task)) {
    return `Task ${task.id} was report-only, so its research agent was not kept; start new research.`;
  }
  const step = presentationRequestStep({ id: "" }, terminal, nowMs);
  if (step === "gone") return `Task ${task.id}'s research agent has closed; start new research.`;
  if (step !== "send") return `Task ${task.id}'s research agent is busy; try again shortly.`;
  return undefined;
}

export type ResearchFollowUpDeps = Readonly<{
  readTerminal: (job: WorkerTerminalJob) => Promise<WorkerTerminalState | undefined>;
  send: (
    job: WorkerTerminalJob,
    id: string,
    request: WorkerMockupRequest,
    timeoutMs: number,
  ) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs?: number;
}>;

/**
 * Asks a completed scout's kept research agent one read-only question through the mockup turn
 * channel: its only writable folder is the follow-up's own, in its job directory, where it writes
 * the answer. Throws a one-line reason when the agent can't take it. Waits a bounded time; past
 * that, returns where the answer will appear.
 */
export async function askResearchAgent(
  task: Pick<TaskRecord, "id" | "kind" | "stage" | "researchContinuation">,
  agent: PresentationAgent | undefined,
  input: Readonly<{ id: string; question: string }>,
  deps: ResearchFollowUpDeps,
): Promise<string> {
  const job: WorkerTerminalJob | undefined =
    agent === undefined
      ? undefined
      : {
          id: agent.jobId,
          taskId: task.id,
          generation: agent.generation,
          role: "scout",
          cwd: agent.cwd,
          jobPath: agent.jobPath,
        };
  const terminal = job === undefined ? undefined : await deps.readTerminal(job);
  const refusal = researchFollowUpRefusal(task, terminal, deps.now());
  if (refusal !== undefined) throw new Error(refusal);
  if (job === undefined) throw new Error(`Task ${task.id}'s research agent has closed.`);
  const dir = join(dirname(job.jobPath), `follow-up-${input.id}`);
  const briefPath = join(dir, "question.md");
  const answerPath = join(dir, "answer.md");
  await mkdir(dir, { recursive: true });
  await writeFile(
    briefPath,
    [
      "The coordinator has a follow-up question about your research.",
      "Answer from your findings and read-only inspection. Do not change repository files.",
      `Write your answer as short Markdown to ${answerPath}, then stop.`,
      "",
      `Question: ${input.question}`,
    ].join("\n"),
  );
  try {
    await deps.send(job, input.id, { briefPath, artifactDir: dir }, REQUEST_ACK_TIMEOUT_MS);
  } catch {
    return "The research agent did not take the question; it may be busy. Try again shortly.";
  }
  const deadline = deps.now() + (deps.waitMs ?? ANSWER_WAIT_MS);
  while (true) {
    const terminal = await deps.readTerminal(job);
    const step = presentationRequestStep(input, terminal, deps.now());
    if (step === "finished" || step === "gone") {
      try {
        return (await readFile(answerPath, "utf8")).trim();
      } catch {
        return "The research agent finished without writing an answer.";
      }
    }
    if (deps.now() >= deadline) {
      return `The research agent is still answering; read ${answerPath} when it finishes.`;
    }
    await deps.sleep(ANSWER_POLL_MS);
  }
}
