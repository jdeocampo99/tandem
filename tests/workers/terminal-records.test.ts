import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndpointInspection } from "../../src/terminal-backend/contract.ts";
import {
  liveWorkerTerminal,
  readWorkerTerminalCommand,
  replyUsage,
  requestWorkerTerminalCommand,
  traceWorkerTurn,
  type WorkerTerminalJob,
  type WorkerTerminalState,
  workerDelegationStopped,
  writeWorkerTerminal,
} from "../../src/workers/terminal.ts";
import { isTokenTally, parseCommand, parseTerminal } from "../../src/workers/terminal-records.ts";

const NOW = 1_700_000_000_000;
const state: WorkerTerminalState = {
  schemaVersion: 1,
  jobId: "job",
  taskId: "task",
  generation: 0,
  role: "implementer",
  cwd: "/tmp",
  pid: 1,
  phase: "idle",
  completed: true,
  heartbeatAt: new Date(NOW).toISOString(),
};
const identity = { id: state.jobId, taskId: state.taskId, generation: state.generation };
const command = {
  schemaVersion: 1,
  id: "control",
  jobId: identity.id,
  taskId: identity.taskId,
  generation: identity.generation,
  action: "pause",
  expiresAt: new Date(NOW + 100).toISOString(),
} as const;

test("terminal decoding preserves identity, extra fields, legacy roles and numeric boundaries", () => {
  const extended = { extra: "first", ...state, commandId: undefined };
  expect<unknown>(parseTerminal(extended)).toBe(extended);
  expect(JSON.stringify(parseTerminal(extended))).toBe(JSON.stringify(extended));
  for (const role of ["scout", "implementer", "reviewer", "verifier"] as const) {
    expect(parseTerminal({ ...state, role }).role).toBe(role);
  }
  for (const phase of ["starting", "busy", "idle", "paused", "closing", "closed"] as const) {
    expect(parseTerminal({ ...state, phase }).phase).toBe(phase);
  }
  for (const invalid of [
    { schemaVersion: 2 },
    { jobId: " " },
    { taskId: "task\n" },
    { generation: -1 },
    { generation: "0" },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { role: "coordinator" },
    { cwd: "relative" },
    { pid: 0 },
    { pid: 1.5 },
    { phase: "unknown" },
    { completed: "true" },
    { heartbeatAt: "invalid" },
    { commandId: "" },
    { settledCommandId: null },
  ]) {
    expect(() => parseTerminal({ ...state, ...invalid })).toThrow(
      "interactive worker terminal state is malformed",
    );
  }
  expect(parseTerminal({ ...state, generation: Number.MAX_SAFE_INTEGER }).generation).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test("commands preserve extras and validate shape before stale identity", () => {
  const extended = { extra: "first", ...command };
  expect(parseCommand(extended, identity)).toBe(extended);
  expect(() => parseCommand({ ...command, jobId: "other" }, identity)).toThrow(
    "interactive worker terminal identity is stale",
  );
  expect(() => parseCommand({ ...command, jobId: "other", action: "unknown" }, identity)).toThrow(
    "interactive worker terminal command is malformed",
  );
  const mockup = { briefPath: "/tmp/brief", artifactDir: "/tmp/artifact", extra: true };
  expect(parseCommand({ ...command, action: "mockup", mockup }, identity).mockup).toBe(mockup);
  for (const invalid of [
    { action: "mockup" },
    { mockup },
    { action: "mockup", mockup: { ...mockup, briefPath: "relative" } },
    { expiresAt: "invalid" },
    { id: "request\0" },
  ]) {
    expect(() => parseCommand({ ...command, ...invalid }, identity)).toThrow(
      "interactive worker terminal command is malformed",
    );
  }
});

test("usage decoding retains null cache defaults and refuses missing or invalid counts", () => {
  const usage = { input: 1.5, output: 2, cacheRead: null, cacheWrite: null };
  expect(replyUsage({ role: "assistant", usage })).toEqual({
    provider: "unknown",
    model: "unknown",
    input: 1.5,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  });
  expect(replyUsage({ role: "assistant", usage: { ...usage, cost: {} } })).toBeUndefined();
  for (const invalid of [-1, Infinity, NaN, "1"]) {
    expect(replyUsage({ role: "assistant", usage: { ...usage, output: invalid } })).toBeUndefined();
  }
  const tally = {
    extra: true,
    schemaVersion: 1,
    provider: "openai",
    model: "model",
    inputTokens: 1.5,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    replies: 0.5,
  } as const;
  expect(isTokenTally(tally) ? tally : undefined).toBe(tally);
  const negativeReplies = { ...tally, replies: -1 };
  expect(isTokenTally(negativeReplies) ? negativeReplies : undefined).toBeUndefined();
  const blankProvider = { ...tally, provider: " " };
  expect(isTokenTally(blankProvider) ? blankProvider : undefined).toBeUndefined();
});

test("injected clocks bound live heartbeat freshness and stopped delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-terminal-freshness-"));
  try {
    const job: WorkerTerminalJob = {
      ...identity,
      role: "implementer",
      cwd: root,
      jobPath: join(root, "job.json"),
    };
    const inspection: EndpointInspection = {
      endpoint: {
        terminal: "herdr",
        sessionId: "session",
        workspaceId: "workspace",
        tabId: "tab",
        paneId: "pane",
        role: "implementer",
        generation: job.generation,
      },
      pane: { paneId: "pane", tabId: "tab", workspaceId: "workspace", foregroundCwd: root },
      processInfo: {
        paneId: "pane",
        shellPid: undefined,
        foregroundProcessGroupId: undefined,
        foregroundProcesses: [
          { pid: state.pid, name: "omp", argv: ["omp"], argv0: "omp", commandLine: "omp" },
        ],
      },
      activeWorker: true,
    };
    const current = { ...state, cwd: root };
    await writeWorkerTerminal(job.jobPath, current);
    for (const offset of [-30_000, 0, 30_000]) {
      expect(await liveWorkerTerminal(inspection, job, () => NOW + offset)).toEqual(current);
      expect(await workerDelegationStopped(inspection, job, () => NOW + offset)).toBe(true);
    }
    for (const offset of [-30_001, 30_001]) {
      await expect(liveWorkerTerminal(inspection, job, () => NOW + offset)).rejects.toThrow(
        "interactive worker terminal heartbeat is stale",
      );
      await expect(workerDelegationStopped(inspection, job, () => NOW + offset)).rejects.toThrow(
        "interactive worker terminal heartbeat is stale",
      );
    }
    await writeWorkerTerminal(job.jobPath, { ...current, completed: false, phase: "busy" });
    expect(await workerDelegationStopped(inspection, job, () => NOW)).toBe(false);
    await writeWorkerTerminal(job.jobPath, { ...current, completed: false, phase: "paused" });
    expect(await workerDelegationStopped(inspection, job, () => NOW)).toBe(true);
    await expect(workerDelegationStopped(inspection, job, () => NOW + 30_001)).rejects.toThrow(
      "interactive worker terminal heartbeat is stale",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control uses injected IDs, exact deadlines, fifty-millisecond polls and owned cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-terminal-timing-"));
  try {
    const job: WorkerTerminalJob = {
      ...identity,
      role: "implementer",
      cwd: root,
      jobPath: join(root, "job.json"),
    };
    await writeWorkerTerminal(job.jobPath, { ...state, cwd: root });
    let now = NOW;
    const polls: number[] = [];
    await expect(
      requestWorkerTerminalCommand(job, "pause", 100, {
        createId: () => "fixed-id",
        now: () => now,
        sleep: async (ms) => {
          polls.push(ms);
          const pending = await readWorkerTerminalCommand(job.jobPath, job, () => now);
          expect(pending).toMatchObject({
            id: "fixed-id",
            expiresAt: new Date(NOW + 100).toISOString(),
          });
          now += ms;
        },
      }),
    ).rejects.toThrow("interactive worker did not acknowledge pause; its terminal was preserved");
    expect(polls).toEqual([50, 50]);
    expect(await readWorkerTerminalCommand(job.jobPath, job, () => NOW)).toBeUndefined();
    await writeFile(`${job.jobPath}.terminal.json.command`, JSON.stringify(command));
    expect(await readWorkerTerminalCommand(job.jobPath, job, () => NOW + 99)).toEqual(command);
    expect(await readWorkerTerminalCommand(job.jobPath, job, () => NOW + 100)).toBeUndefined();
    traceWorkerTurn(job.jobPath, "event", {}, () => NOW);
    expect(JSON.parse(await readFile(`${job.jobPath}.trace.jsonl`, "utf8")).at).toBe(
      new Date(NOW).toISOString(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
