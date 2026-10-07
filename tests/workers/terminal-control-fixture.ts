import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRequest, CommandResult, Endpoint } from "../../src/contracts.ts";
import {
  readWorkerTerminalCommand,
  type WorkerTerminalJob,
  writeWorkerTerminal,
} from "../../src/workers/terminal.ts";
export const ENDPOINT: Endpoint = {
  terminal: "herdr" as const,
  sessionId: "session-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  role: "scout",
  generation: 0,
};

/** The Claude Code pane a close drives: active until it has taken `exitSendsNeeded` exit-key bursts. */
export type Pane = { active: boolean; exitBursts: number; exitSendsNeeded: number };

export function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

/** A Herdr boundary answering only the commands a close issues, playing one pane's exit behavior. */
export function paneRunner(pane: Pane) {
  return async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    if (argv[0] !== "herdr") return ok();
    if (argv.includes("pane") && argv.includes("get")) {
      return ok(
        JSON.stringify({
          result: {
            pane: {
              pane_id: ENDPOINT.paneId,
              tab_id: ENDPOINT.tabId,
              workspace_id: ENDPOINT.workspaceId,
              foreground_cwd: request.cwd,
            },
          },
        }),
      );
    }
    if (argv.includes("process-info")) {
      return ok(
        JSON.stringify({
          result: {
            process_info: {
              pane_id: ENDPOINT.paneId,
              foreground_processes: pane.active
                ? [{ pid: 1, name: "claude", argv: ["claude"] }]
                : [],
            },
          },
        }),
      );
    }
    if (argv.includes("send-keys")) {
      pane.exitBursts += 1;
      if (pane.exitBursts >= pane.exitSendsNeeded) pane.active = false;
      return ok();
    }
    return ok();
  };
}

async function writeTerminal(
  jobPath: string,
  phase: "idle" | "closing" | "paused",
  commandId?: string,
): Promise<void> {
  await writeWorkerTerminal(jobPath, {
    schemaVersion: 1,
    jobId: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "scout",
    cwd: jobPath.replace(/\/job\.json$/, ""),
    pid: 1,
    phase,
    completed: true,
    heartbeatAt: new Date().toISOString(),
    ...(commandId === undefined ? {} : { commandId }),
  });
}

/** Writes an idle, completed worker and plays its side of the close: it acknowledges with "closing". */
export async function completedWorker(
  home: string,
): Promise<{ job: WorkerTerminalJob; stopAck: () => Promise<void> }> {
  const jobPath = join(home, "job.json");
  await writeFile(
    jobPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      cwd: home,
      harness: "claude-code",
      model: { model: "claude-code/sonnet", thinking: "low" },
      prompt: "Research.",
      resultPath: join(home, "result.json"),
    }),
  );
  await writeTerminal(jobPath, "idle");
  let acknowledgements = Promise.resolve();
  const timer = setInterval(() => {
    acknowledgements = acknowledgements.then(async () => {
      const command = await readWorkerTerminalCommand(jobPath, job);
      if (command === undefined) return;
      await writeTerminal(jobPath, command.action === "pause" ? "paused" : "closing", command.id);
    });
  }, 5);
  const job: WorkerTerminalJob = {
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "scout",
    cwd: home,
    jobPath,
  };
  return {
    job,
    stopAck: async () => {
      clearInterval(timer);
      await acknowledgements;
    },
  };
}
