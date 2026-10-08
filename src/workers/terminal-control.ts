import { realpath as defaultRealpath, readFile } from "node:fs/promises";
import {
  checkedPath,
  EndpointBusyError,
  EndpointOwnershipError,
  type WorktreeAdapterOptions,
} from "../adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../contracts.ts";
import { harnessFor } from "../harness/resolve.ts";
import type { DurableJob } from "../runtime/schema.ts";
import { isMissingEndpoint } from "../service/records.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { parseWorkerJob } from "./jobs.ts";
import {
  liveWorkerTerminal,
  readWorkerTerminal,
  requestWorkerTerminalCommand,
  type WorkerTerminalJob,
  workerDelegationStopped,
} from "./terminal.ts";

const FRESH_PANE_SETTLE_MS = 5_000;
const EXIT_WAIT_MS = 20_000;
// A lost first key can leave the harness asking for Ctrl-D again (#256).
const EXIT_RESEND_AFTER_MS = 6_000;
const EXIT_POLL_MS = 50;
export type WorkerTerminalInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  job?: WorkerTerminalJob;
}>;
export type ExitWaitTiming = Readonly<{
  waitMs?: number;
  resendAfterMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

function ownsEndpoint(job: DurableJob, endpoint: Endpoint): boolean {
  const owned = job.endpoint;
  return (
    owned !== undefined &&
    owned.terminal === endpoint.terminal &&
    owned.sessionId === endpoint.sessionId &&
    owned.workspaceId === endpoint.workspaceId &&
    owned.tabId === endpoint.tabId &&
    owned.paneId === endpoint.paneId
  );
}

export function workerJobForEndpoint(
  jobs: readonly DurableJob[],
  endpoint: Endpoint,
): DurableJob | undefined {
  return jobs.findLast((job) => ownsEndpoint(job, endpoint));
}

// A failed later launch never occupied the pane; validation jobs keep no terminal record.
export async function workerJobOccupyingEndpoint(
  jobs: readonly DurableJob[],
  endpoint: Endpoint,
): Promise<DurableJob | undefined> {
  const owned = jobs.filter((job) => ownsEndpoint(job, endpoint));
  const newest = owned.at(-1);
  if (newest === undefined || newest.role === "validation") return newest;
  for (const job of owned.toReversed()) {
    if (job.role === "validation") continue;
    // An unreadable record still names a worker that started; keep it so the check fails closed.
    const started = await readWorkerTerminal(job).then(
      (terminal) => terminal !== undefined,
      () => true,
    );
    if (started) return job;
  }
  return newest;
}

export async function prepareWorkerTerminal(
  terminal: TerminalBackend,
  input: WorkerTerminalInput,
  timing: ExitWaitTiming = {},
): Promise<void> {
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? Bun.sleep;
  let inspection = await terminal.inspect(input);
  // A fresh pane has no prior job; its shell startup can briefly hold the foreground.
  if (input.job === undefined) {
    const deadline = now() + FRESH_PANE_SETTLE_MS;
    while (inspection.activeWorker && now() < deadline) {
      await sleep(50);
      inspection = await terminal.inspect(input);
    }
  }
  if (!inspection.activeWorker) return;
  const worker =
    input.job === undefined ? undefined : await liveWorkerTerminal(inspection, input.job);
  if (
    input.job === undefined ||
    worker === undefined ||
    (!worker.completed && worker.phase !== "paused") ||
    (worker.phase !== "idle" && worker.phase !== "paused")
  ) {
    throw new EndpointBusyError(input.endpoint);
  }
  await requestWorkerTerminalCommand(input.job, "close");
  const closingInspection = await terminal.inspect(input);
  if (!closingInspection.activeWorker) return;
  const closingTerminal = await liveWorkerTerminal(closingInspection, input.job);
  if (closingTerminal?.phase !== "closing") throw new EndpointBusyError(input.endpoint);
  const spec = parseWorkerJob(JSON.parse(await readFile(input.job.jobPath, "utf8")));
  const keys = harnessFor(spec.harness).exitKeys;
  await terminal.sendKeys({ ...input, keys });
  const waitMs = timing.waitMs ?? EXIT_WAIT_MS;
  const resendAfterMs = timing.resendAfterMs ?? EXIT_RESEND_AFTER_MS;
  const pollMs = timing.pollMs ?? EXIT_POLL_MS;
  const startedAt = now();
  let resent = false;
  while ((await terminal.inspect(input)).activeWorker) {
    const waited = now() - startedAt;
    if (waited >= waitMs) {
      throw new Error("interactive worker acknowledged close but its process has not exited");
    }
    if (!resent && waited >= resendAfterMs) {
      resent = true;
      await terminal.sendKeys({ ...input, keys });
    }
    await sleep(pollMs);
  }
}

export async function pauseWorkerTerminal(
  terminal: TerminalBackend,
  input: WorkerTerminalInput,
): Promise<void> {
  const inspection = await terminal.inspect(input);
  if (!inspection.activeWorker) return;
  const worker =
    input.job === undefined ? undefined : await liveWorkerTerminal(inspection, input.job);
  if (input.job !== undefined && worker !== undefined) {
    if (worker.phase !== "paused") await requestWorkerTerminalCommand(input.job, "pause");
    return;
  }
  if (input.job !== undefined && (await readWorkerTerminal(input.job)) !== undefined) {
    throw new EndpointBusyError(input.endpoint);
  }
  await terminal.interrupt(input);
}

export type WorkerPaneStop =
  | Readonly<{ status: "stopped" }>
  | Readonly<{ status: "still-running" }>
  | Readonly<{ status: "foreign" | "unknown"; error: unknown }>;
type StopWorkerPaneInput = WorkerTerminalInput &
  (
    | Readonly<{ goal: "pause"; skipStopped?: boolean }>
    | Readonly<{
        goal: "close";
        run: CommandRunner;
        clock: () => number;
        sleep?: (ms: number) => Promise<void>;
      }>
  );

function paneFailure(error: unknown): WorkerPaneStop {
  if (isMissingEndpoint(error)) return { status: "stopped" };
  return { status: error instanceof EndpointOwnershipError ? "foreign" : "unknown", error };
}

async function workerPaneState(
  terminal: TerminalBackend,
  input: WorkerTerminalInput & Readonly<{ skipStopped?: boolean }>,
  action: "inspect" | "pause" | "close" = "inspect",
): Promise<WorkerPaneStop> {
  try {
    if (action === "close") {
      await terminal.close(input);
      return { status: "stopped" };
    }
    if (action === "pause") {
      if (
        input.skipStopped &&
        (await workerDelegationStopped(await terminal.inspect(input), input.job))
      )
        return { status: "stopped" };
      await pauseWorkerTerminal(terminal, input);
    }
    const inspection = await terminal.inspect(input);
    const stopped =
      action === "pause"
        ? await workerDelegationStopped(inspection, input.job)
        : !inspection.activeWorker;
    return { status: stopped ? "stopped" : "still-running" };
  } catch (error) {
    return paneFailure(error);
  }
}

/** A pause retains the pane for continuation; closure requires proof the process exited. */
export async function stopWorkerPane(
  terminal: TerminalBackend,
  input: StopWorkerPaneInput,
): Promise<WorkerPaneStop> {
  if (input.goal === "pause") return workerPaneState(terminal, input, "pause");
  let state = await workerPaneState(terminal, input);
  if (state.status === "foreign" || state.status === "unknown") return state;
  if (state.status === "stopped") return workerPaneState(terminal, input, "close");
  try {
    await pauseWorkerTerminal(terminal, input);
  } catch {
    // Pause is best effort; interrupt can still prove exit.
  }
  state = await workerPaneState(terminal, input);
  if (state.status === "foreign" || state.status === "unknown") return state;
  if (state.status === "stopped") return workerPaneState(terminal, input, "close");
  try {
    await terminal.interrupt({ ...input, timeoutMs: 2_000, pollIntervalMs: 100 });
    return workerPaneState(terminal, input, "close");
  } catch {
    // Signal only the recorded PID re-proven in this pane's foreground group.
  }
  return signalForegroundWorker(terminal, input);
}

async function signalForegroundWorker(
  terminal: TerminalBackend,
  input: Extract<StopWorkerPaneInput, { goal: "close" }>,
): Promise<WorkerPaneStop> {
  if (input.job === undefined) return { status: "still-running" };
  const worker = await readWorkerTerminal(input.job).catch(() => undefined);
  if (worker === undefined)
    return { status: "unknown", error: new Error("worker terminal record is unavailable") };
  const inspection = await terminal.inspect(input).catch(() => undefined);
  const foreground = inspection?.processInfo.foregroundProcesses;
  if (!foreground?.some((process) => process.pid === worker.pid)) {
    return {
      status: "unknown",
      error: new Error("worker PID is not in the owned pane's foreground process group"),
    };
  }
  try {
    await input.run({ argv: ["kill", "-TERM", String(worker.pid)], cwd: input.cwd });
  } catch {
    // The poll decides the outcome even when signal delivery was not acknowledged.
  }
  const deadline = input.clock() + 5_000;
  const sleep = input.sleep ?? Bun.sleep;
  for (let attempt = 0; attempt < 50 && input.clock() < deadline; attempt++) {
    const state = await workerPaneState(terminal, input);
    if (state.status === "stopped") return workerPaneState(terminal, input, "close");
    if (state.status === "foreign" || state.status === "unknown") return state;
    await sleep(100);
  }
  return { status: "still-running" };
}

export async function openReviewerEndpoint(
  terminal: TerminalBackend,
  input: Readonly<{
    sessionId: string;
    cwd: string;
    writer: Endpoint;
    generation: number;
    writerJob?: WorkerTerminalJob;
  }>,
  options: WorktreeAdapterOptions = {},
): Promise<Endpoint> {
  if (input.sessionId !== input.writer.sessionId) {
    throw new EndpointOwnershipError(
      input.writer,
      "reviewer session does not match writer session",
    );
  }
  const writerInspection = await terminal.inspect({ endpoint: input.writer, cwd: input.cwd });
  if (!(await workerDelegationStopped(writerInspection, input.writerJob)))
    throw new EndpointBusyError(input.writer);
  const writerPane = writerInspection.pane;
  if (writerPane.foregroundCwd === undefined) {
    throw new EndpointOwnershipError(input.writer, "writer working directory is unavailable");
  }
  const resolvePhysicalPath = options.realpath ?? defaultRealpath;
  const [writerDirectory, reviewerDirectory] = await Promise.all([
    resolvePhysicalPath(writerPane.foregroundCwd),
    resolvePhysicalPath(checkedPath(input.cwd, "cwd")),
  ]);
  if (writerDirectory !== reviewerDirectory) {
    throw new EndpointOwnershipError(
      input.writer,
      `writer cwd ${JSON.stringify(writerPane.foregroundCwd)} does not match reviewer cwd ${JSON.stringify(input.cwd)}`,
    );
  }
  return terminal.splitBeside({
    anchor: input.writer,
    cwd: input.cwd,
    role: "reviewer",
    generation: input.generation,
  });
}
