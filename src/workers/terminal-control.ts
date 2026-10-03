import { readFile } from "node:fs/promises";
import { inspectEndpoint, interruptEndpoint, sendExitKeys } from "../adapters/herdr.ts";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../contracts.ts";
import { harnessFor } from "../harness/resolve.ts";
import type { DurableJob } from "../runtime/schema.ts";
import { parseWorkerJob } from "./jobs.ts";
import {
  liveWorkerTerminal,
  readWorkerTerminal,
  requestWorkerTerminalCommand,
  type WorkerTerminalJob,
} from "./terminal.ts";

const FRESH_PANE_SETTLE_MS = 5_000;

export type WorkerTerminalInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  job?: WorkerTerminalJob;
}>;

function ownsEndpoint(job: DurableJob, endpoint: Endpoint): boolean {
  const owned = job.endpoint;
  return (
    owned !== undefined &&
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
  run: CommandRunner,
  input: WorkerTerminalInput,
): Promise<void> {
  let inspection = await inspectEndpoint(run, input);
  // A fresh pane has no prior job; its shell startup can briefly hold the foreground.
  if (input.job === undefined) {
    const deadline = Date.now() + FRESH_PANE_SETTLE_MS;
    while (inspection.activeWorker && Date.now() < deadline) {
      await Bun.sleep(50);
      inspection = await inspectEndpoint(run, input);
    }
  }
  if (!inspection.activeWorker) return;
  const terminal =
    input.job === undefined ? undefined : await liveWorkerTerminal(inspection, input.job);
  if (
    input.job === undefined ||
    terminal === undefined ||
    (!terminal.completed && terminal.phase !== "paused") ||
    (terminal.phase !== "idle" && terminal.phase !== "paused")
  ) {
    throw new EndpointBusyError(input.endpoint);
  }
  await requestWorkerTerminalCommand(input.job, "close");
  const closingInspection = await inspectEndpoint(run, input);
  if (!closingInspection.activeWorker) return;
  const closingTerminal = await liveWorkerTerminal(closingInspection, input.job);
  if (closingTerminal?.phase !== "closing") throw new EndpointBusyError(input.endpoint);
  await sendExitKeys(run, input, await exitKeys(input.job));
  const deadline = Date.now() + 10_000;
  while ((await inspectEndpoint(run, input)).activeWorker) {
    if (Date.now() >= deadline) {
      throw new Error("interactive worker acknowledged close but its process has not exited");
    }
    await Bun.sleep(50);
  }
}

export async function pauseWorkerTerminal(
  run: CommandRunner,
  input: WorkerTerminalInput,
): Promise<void> {
  const inspection = await inspectEndpoint(run, input);
  if (!inspection.activeWorker) return;
  const terminal =
    input.job === undefined ? undefined : await liveWorkerTerminal(inspection, input.job);
  if (input.job !== undefined && terminal !== undefined) {
    if (terminal.phase !== "paused") await requestWorkerTerminalCommand(input.job, "pause");
    return;
  }
  if (input.job !== undefined && (await readWorkerTerminal(input.job)) !== undefined) {
    throw new EndpointBusyError(input.endpoint);
  }
  await interruptEndpoint(run, input);
}
