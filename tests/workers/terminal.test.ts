import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewerEndpoint, type HerdrPaneInspection } from "../../src/adapters/herdr.ts";
import { EndpointBusyError } from "../../src/adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../../src/contracts.ts";
import {
  addReplyUsage,
  readWorkerTerminalCommand,
  readWorkerTokenTally,
  replyUsage,
  requestWorkerTerminalCommand,
  traceWorkerTurn,
  type WorkerTerminalJob,
  type WorkerTerminalState,
  workerDelegationStopped,
  writeWorkerTerminal,
  writeWorkerTokenTally,
} from "../../src/workers/terminal.ts";
import { pauseWorkerTerminal, prepareWorkerTerminal } from "../../src/workers/terminal-control.ts";

function fixture(root: string) {
  const job: WorkerTerminalJob = {
    id: "writer-job",
    taskId: "writer-task",
    generation: 2,
    role: "implementer",
    cwd: root,
    jobPath: join(root, "job.json"),
  };
  const endpoint: Endpoint = {
    sessionId: "owned-session",
    workspaceId: "owned-workspace",
    tabId: "owned-tab",
    paneId: "writer-pane",
    role: "implementer",
    generation: 2,
  };
  const state: WorkerTerminalState = {
    schemaVersion: 1,
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: "implementer",
    cwd: root,
    pid: process.pid,
    phase: "idle",
    completed: true,
    heartbeatAt: new Date().toISOString(),
  };
  const inspection: HerdrPaneInspection = {
    endpoint,
    pane: {
      paneId: endpoint.paneId,
      workspaceId: endpoint.workspaceId,
      tabId: endpoint.tabId,
      foregroundCwd: root,
    },
    processInfo: {
      paneId: endpoint.paneId,
      shellPid: undefined,
      foregroundProcessGroupId: undefined,
      foregroundProcesses: [
        { pid: process.pid, name: "omp", argv: ["omp"], argv0: "omp", commandLine: "omp" },
      ],
    },
    activeWorker: true,
  };
  return { job, endpoint, state, inspection };
}

function nativeRunner(inspection: HerdrPaneInspection): CommandRunner {
  return async (request) => {
    const action = request.argv[4];
    let result: unknown;
    if (action === "get") {
      result = {
        pane: {
          pane_id: inspection.endpoint.paneId,
          workspace_id: inspection.endpoint.workspaceId,
          tab_id: inspection.endpoint.tabId,
          foreground_cwd: inspection.pane.foregroundCwd,
        },
      };
    } else if (action === "process-info") {
      result = {
        process_info: {
          pane_id: inspection.endpoint.paneId,
          foreground_processes: inspection.processInfo.foregroundProcesses,
        },
      };
    } else if (action === "split") {
      result = {
        pane: {
          pane_id: "review-pane",
          workspace_id: inspection.endpoint.workspaceId,
          tab_id: inspection.endpoint.tabId,
          foreground_cwd: inspection.pane.foregroundCwd,
        },
      };
    } else {
      throw new Error(`unexpected native operation ${request.argv.join(" ")}`);
    }
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
}

test("review can coexist with a completed interactive writer, but not a busy delegation or foreign PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-review-"));
  try {
    const { job, endpoint, state, inspection } = fixture(root);
    const input = {
      sessionId: endpoint.sessionId,
      cwd: root,
      writer: endpoint,
      generation: 2,
      writerJob: job,
    };
    const run = nativeRunner(inspection);
    await writeWorkerTerminal(job.jobPath, { ...state, phase: "busy", completed: false });
    await expect(createReviewerEndpoint(run, input)).rejects.toBeInstanceOf(EndpointBusyError);
    await writeWorkerTerminal(job.jobPath, state);
    const reviewer = await createReviewerEndpoint(run, input);
    expect(reviewer.endpoint.paneId).toBe("review-pane");
    expect(reviewer.endpoint.workspaceId).toBe(endpoint.workspaceId);
    const foreign = {
      ...inspection,
      processInfo: {
        ...inspection.processInfo,
        foregroundProcesses: inspection.processInfo.foregroundProcesses.map((entry) => ({
          ...entry,
          pid: entry.pid + 1,
        })),
      },
    };
    await expect(createReviewerEndpoint(nativeRunner(foreign), input)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained human conversation cannot be closed to reuse the worker pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-busy-"));
  try {
    const { job, endpoint, state, inspection } = fixture(root);
    await writeWorkerTerminal(job.jobPath, { ...state, phase: "busy" });
    await expect(
      prepareWorkerTerminal(nativeRunner(inspection), { endpoint, cwd: root, job }),
    ).rejects.toBeInstanceOf(EndpointBusyError);
    expect(await readWorkerTerminalCommand(job.jobPath, job)).toBeUndefined();
    expect(await workerDelegationStopped(inspection, job)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale terminal heartbeat cannot authorize validation beside a live writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-stale-"));
  try {
    const { job, state, inspection } = fixture(root);
    await writeWorkerTerminal(job.jobPath, state);
    expect(await workerDelegationStopped(inspection, job)).toBe(true);
    await writeWorkerTerminal(job.jobPath, { ...state, heartbeatAt: new Date(0).toISOString() });
    await expect(workerDelegationStopped(inspection, job)).rejects.toThrow();
    expect(await workerDelegationStopped(inspection)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed interactive identity cannot authorize interrupting a replacement process", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-replacement-"));
  try {
    const { job, endpoint, state, inspection } = fixture(root);
    await writeWorkerTerminal(job.jobPath, { ...state, phase: "closed" });
    await expect(
      pauseWorkerTerminal(nativeRunner(inspection), {
        endpoint,
        job,
        cwd: root,
      }),
    ).rejects.toBeInstanceOf(EndpointBusyError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unacknowledged terminal control expires without leaving a deferred close request", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-control-"));
  try {
    const { job, state } = fixture(root);
    await writeWorkerTerminal(job.jobPath, state);
    await expect(requestWorkerTerminalCommand(job, "close", 25)).rejects.toThrow();
    expect(await readWorkerTerminalCommand(job.jobPath, job)).toBeUndefined();
    const pause = requestWorkerTerminalCommand(job, "pause", 1_000);
    let command = await readWorkerTerminalCommand(job.jobPath, job);
    const deadline = Date.now() + 500;
    while (command === undefined && Date.now() < deadline) {
      await Bun.sleep(5);
      command = await readWorkerTerminalCommand(job.jobPath, job);
    }
    if (command === undefined) throw new Error("pause request was not published");
    await writeWorkerTerminal(job.jobPath, { ...state, phase: "paused", commandId: command.id });
    await pause;
    expect(await readWorkerTerminalCommand(job.jobPath, job)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh pane still starting its shell is awaited before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-fresh-"));
  try {
    const { endpoint, inspection } = fixture(root);
    let calls = 0;
    const settled = {
      ...inspection,
      processInfo: { ...inspection.processInfo, foregroundProcesses: [] },
    };
    const runner = nativeRunner(inspection);
    const settledRunner = nativeRunner(settled);
    const run: typeof runner = (request) =>
      ++calls < 3 ? runner(request) : settledRunner(request);
    await prepareWorkerTerminal(run, { endpoint, cwd: root });
    expect(calls).toBeGreaterThan(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the turn trace appends one line per event and never throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-interactive-trace-"));
  try {
    const jobPath = join(root, "job.json");
    traceWorkerTurn(jobPath, "agent_end", { willContinue: true });
    traceWorkerTurn(jobPath, "agent_end_done", { phase: "busy" });
    const lines = (await readFile(`${jobPath}.trace.jsonl`, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["agent_end", "agent_end_done"]);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ willContinue: true });
    expect(() => traceWorkerTurn(join(root, "missing", "job.json"), "agent_end")).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker's replies add up to one token tally that round-trips through its job file", async () => {
  const assistant = (input: number, output: number, cacheRead: number, total: number) => ({
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: 0, cost: { total } },
  });
  expect(replyUsage({ role: "user", content: "hi" })).toBeUndefined();
  expect(replyUsage({ ...assistant(1, 1, 0, 0), usage: { input: -1 } })).toBeUndefined();

  const first = replyUsage(assistant(1_000, 200, 5_000, 0.02));
  const second = replyUsage(assistant(500, 100, 6_000, 0.01));
  if (first === undefined || second === undefined) throw new Error("replies should parse");
  const tally = addReplyUsage(addReplyUsage(undefined, first), second);
  expect(tally).toMatchObject({
    inputTokens: 1_500,
    outputTokens: 300,
    cacheReadTokens: 11_000,
    replies: 2,
  });
  expect(tally.costUsd).toBeCloseTo(0.03);

  const home = await mkdtemp(join(tmpdir(), "tandem-token-tally-"));
  try {
    const jobPath = join(home, "job.json");
    expect(await readWorkerTokenTally(jobPath)).toBeUndefined();
    await writeWorkerTokenTally(jobPath, tally);
    expect(await readWorkerTokenTally(jobPath)).toEqual(tally);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
