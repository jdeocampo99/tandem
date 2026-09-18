import { inspectEndpoint, interruptEndpoint, sendExitKey } from "../adapters/herdr.ts";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../contracts.ts";
import type { DurableJob } from "../runtime/schema.ts";
import {
  liveWorkerTerminal,
  readWorkerTerminal,
  requestWorkerTerminalCommand,
  type WorkerTerminalJob,
} from "./terminal.ts";

export type WorkerTerminalInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  job?: WorkerTerminalJob;
}>;

export function workerJobForEndpoint(
  jobs: readonly DurableJob[],
  endpoint: Endpoint,
): DurableJob | undefined {
  return jobs.findLast((job) => {
    const owned = job.endpoint;
    return (
      owned !== undefined &&
      owned.sessionId === endpoint.sessionId &&
      owned.workspaceId === endpoint.workspaceId &&
      owned.tabId === endpoint.tabId &&
      owned.paneId === endpoint.paneId
    );
  });
}

export async function prepareWorkerTerminal(
  run: CommandRunner,
  input: WorkerTerminalInput,
): Promise<void> {
  const inspection = await inspectEndpoint(run, input);
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
  await sendExitKey(run, input);
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
