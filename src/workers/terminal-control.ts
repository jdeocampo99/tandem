import { realpath as defaultRealpath, readFile } from "node:fs/promises";
import {
  checkedPath,
  EndpointBusyError,
  EndpointOwnershipError,
  type WorktreeAdapterOptions,
} from "../adapters/primitives.ts";
import type { Endpoint } from "../contracts.ts";
import { harnessFor } from "../harness/resolve.ts";
import type { DurableJob } from "../runtime/schema.ts";
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
/** How long to wait for an acknowledged worker's process to leave the pane after the exit keys. */
const EXIT_WAIT_MS = 20_000;
/**
 * If the process is still there this long after the exit keys, send them once more. A harness whose
 * first key only arms a confirmation ("Press Ctrl-D again to exit") can be left at that prompt when
 * one key delivery is lost or races the turn's final render; a second delivery completes the exit,
 * as a manual `ctrl+d ctrl+d` did in #256. Re-sending is a no-op once the process has gone.
 */
const EXIT_RESEND_AFTER_MS = 6_000;
const EXIT_POLL_MS = 50;

export type WorkerTerminalInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  job?: WorkerTerminalJob;
}>;

/** Injected only by tests, to drive the exit wait without real time. */
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

/**
 * The job whose worker occupies the pane: the newest one for it that ever wrote a terminal record.
 * A later launch that failed before its worker started leaves no record and never took the pane.
 * Validation jobs keep no terminal record, so the newest one is never skipped.
 */
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

/** The keys that make the job's agent exit, from the harness its job spec records. */
async function exitKeys(job: WorkerTerminalJob): Promise<readonly string[]> {
  const spec = parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8")));
  return harnessFor(spec.harness).exitKeys;
}

export async function prepareWorkerTerminal(
  terminal: TerminalBackend,
  input: WorkerTerminalInput,
  timing: ExitWaitTiming = {},
): Promise<void> {
  let inspection = await terminal.inspect(input);
  // A fresh pane has no prior job; its shell startup can briefly hold the foreground.
  if (input.job === undefined) {
    const deadline = Date.now() + FRESH_PANE_SETTLE_MS;
    while (inspection.activeWorker && Date.now() < deadline) {
      await Bun.sleep(50);
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
  const keys = await exitKeys(input.job);
  await terminal.sendKeys({ ...input, keys });
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? ((ms: number) => Bun.sleep(ms));
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

/**
 * Opens a fresh reviewer pane beside its writer, only once the writer has stopped and its pane
 * still works in the reviewer's directory, so the reviewer reads exactly the writer's tree.
 */
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
  const writerStopped =
    input.writerJob === undefined
      ? !writerInspection.activeWorker
      : await workerDelegationStopped(writerInspection, input.writerJob);
  if (!writerStopped) throw new EndpointBusyError(input.writer);
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
