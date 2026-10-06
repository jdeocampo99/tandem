import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, CommandResult, Endpoint } from "../../src/contracts.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { type WorkerTerminalJob, writeWorkerTerminal } from "../../src/workers/terminal.ts";
import { prepareWorkerTerminal } from "../../src/workers/terminal-control.ts";

const ENDPOINT: Endpoint = {
  terminal: "herdr" as const,
  sessionId: "session-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  role: "scout",
  generation: 0,
};

/** The Claude Code pane a close drives: active until it has taken `exitSendsNeeded` exit-key bursts. */
type Pane = { active: boolean; exitBursts: number; exitSendsNeeded: number };

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

/** A Herdr boundary answering only the commands a close issues, playing one pane's exit behavior. */
function paneRunner(pane: Pane) {
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
  phase: "idle" | "closing",
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
async function completedWorker(
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
      const command = await readFile(`${jobPath}.terminal.json.command`, "utf8").catch(() => "");
      if (command === "") return;
      const commandId = (JSON.parse(command) as { id: string }).id;
      await writeTerminal(jobPath, "closing", commandId);
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

const FAST: Parameters<typeof prepareWorkerTerminal>[2] = {
  waitMs: 1_500,
  resendAfterMs: 200,
  pollMs: 10,
};

test("a close whose first exit keys are lost is completed by re-sending them (#256)", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: 2 };
    await prepareWorkerTerminal(
      terminalBackend(paneRunner(pane)),
      { endpoint: ENDPOINT, cwd: home, job },
      FAST,
    );
    expect(pane.active).toBe(false);
    expect(pane.exitBursts).toBe(2);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("a worker whose process never exits still fails closed after the wait", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: Number.POSITIVE_INFINITY };
    await expect(
      prepareWorkerTerminal(
        terminalBackend(paneRunner(pane)),
        { endpoint: ENDPOINT, cwd: home, job },
        FAST,
      ),
    ).rejects.toThrow("has not exited");
    expect(pane.exitBursts).toBeGreaterThanOrEqual(2);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("a close that takes on the first exit keys sends them only once", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: 1 };
    await prepareWorkerTerminal(
      terminalBackend(paneRunner(pane)),
      { endpoint: ENDPOINT, cwd: home, job },
      FAST,
    );
    expect(pane.active).toBe(false);
    expect(pane.exitBursts).toBe(1);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});
