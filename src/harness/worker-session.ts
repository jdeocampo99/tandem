import { copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { runCommand } from "../adapters/commands.ts";
import type { SessionDeps } from "../session/events.ts";
import { type WorkerHost, WorkerSession } from "../session/worker.ts";
import { type SteeringDelivery, WorkerSteering } from "../session/worker-steering.ts";
import {
  readTaskInbox,
  readWorkerReceipt,
  writeWorkerReceipt,
} from "../tasks/communication-persistence.ts";
import type { TranscriptRef } from "../tasks/timeline.ts";
import { terminalBackend } from "../terminal-backend/compose.ts";
import { parseWorkerControlConfig, WORKER_CONTROL_ENV } from "../workers/control-protocol.ts";
import { parseWorkerJob, persistWorkerResult, type WorkerJob } from "../workers/jobs.ts";
import {
  readWorkerTerminalCommand,
  traceWorkerTurn,
  WORKER_JOB_PATH_ENV,
  writeWorkerTerminal,
  writeWorkerTokenTally,
} from "../workers/terminal.ts";
import { writeWorkerActivity } from "../workers/worker-activity.ts";

/**
 * Worker setup both adapters share: the job a worker process runs, its `WorkerSession`, and its
 * `WorkerSteering`, wired to the job's files. Each harness adds only its host, timers, and
 * transcript.
 */

/** The wall and monotonic clocks a worker session runs on. */
export const SYSTEM_CLOCK: SessionDeps["clock"] = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export type WorkerTrace = (event: string, detail?: Readonly<Record<string, unknown>>) => void;

/** What only the harness supplies to a worker. */
export type WorkerHarness = Readonly<{
  host: WorkerHost;
  timers: SessionDeps["timers"];
  /** The conversation entry the worker is at now, when the harness keeps a transcript. */
  transcript(): TranscriptRef | undefined;
}>;

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Copies one file from the scout's checkout next to its mockup, byte for byte. */
export async function copyMockupAsset(
  input: Readonly<{ cwd: string; artifactDir: string; from: string; name: string }>,
): Promise<string> {
  if (!ASSET_NAME.test(input.name)) {
    throw new Error("name must be a plain file name such as jr-thinking.webp");
  }
  const [root, source] = await Promise.all([
    realpath(input.cwd),
    realpath(resolve(input.cwd, input.from)),
  ]);
  if (!isWithin(root, source))
    throw new Error("from must be a file inside the repository checkout");
  const entry = await lstat(source);
  if (!entry.isFile()) throw new Error("from must be a regular file");
  if (entry.size > MAX_ASSET_BYTES) throw new Error("from is larger than 20 MB");
  const target = resolve(input.artifactDir, input.name);
  if (basename(target) !== input.name) throw new Error("name must be a plain file name");
  await copyFile(source, target);
  return target;
}

/**
 * The worktree's `git status --porcelain=v1` output, or undefined when git cannot report it. The
 * settle-time checkpoint check stays authoritative, so an unreadable status never blocks a finished
 * report; only a quick task's scope question, which claims no changes, refuses it.
 */
async function worktreeStatus(cwd: string): Promise<string | undefined> {
  try {
    const result = await runCommand({
      argv: ["git", "-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The commit `cwd` has checked out, or undefined when git cannot report it. */
async function worktreeHead(cwd: string): Promise<string | undefined> {
  try {
    const result = await runCommand({ argv: ["git", "-C", cwd, "rev-parse", "HEAD"], cwd });
    const head = result.stdout.trim();
    return result.code === 0 && head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
}

/** The job file this worker process was started for, named by its environment; none for a coordinator. */
export function workerJobPath(environment: Readonly<Record<string, string | undefined>>) {
  const path = environment[WORKER_JOB_PATH_ENV];
  return path === undefined || path.trim().length === 0 ? undefined : path;
}

export async function readWorkerJob(path: string): Promise<WorkerJob> {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  return parseWorkerJob(value);
}

export function jobTrace(jobPath: string): WorkerTrace {
  return (event, detail) => traceWorkerTurn(jobPath, event, detail);
}

/** The session that runs one worker job in its pane. */
export function workerSession(
  job: WorkerJob,
  jobPath: string,
  harness: WorkerHarness,
): WorkerSession {
  return new WorkerSession({
    host: harness.host,
    clock: SYSTEM_CLOCK,
    timers: harness.timers,
    status: terminalBackend(
      runCommand,
      job.execution === undefined ? {} : { home: job.execution.home },
    ).agentStatusReporter({
      cwd: job.cwd,
      agentLabel: `tandem-${job.role}-${job.taskId.slice(0, 8)}`,
    }),
    job,
    pid: process.pid,
    terminal: {
      readCommand: () => readWorkerTerminalCommand(jobPath, job),
      writeState: (state) => writeWorkerTerminal(jobPath, state),
      writeTokenTally: (tally) => writeWorkerTokenTally(jobPath, tally),
    },
    persistResult: (result) => {
      const transcript = harness.transcript();
      return persistWorkerResult(
        job.resultPath,
        transcript === undefined ? result : { ...result, transcript },
      );
    },
    readReceipt: (receiptPath) =>
      readWorkerReceipt(receiptPath, {
        jobId: job.id,
        taskId: job.taskId,
        generation: job.generation,
      }),
    gitStatus: worktreeStatus,
    gitHead: worktreeHead,
    readFile: (path) => readFile(path, "utf8"),
    copyAsset: copyMockupAsset,
    trace: jobTrace(jobPath),
  });
}

/**
 * The task's steering for this worker, when the job has task communication; it writes the
 * starting receipt before returning.
 */
export async function openWorkerSteering(
  environment: Readonly<Record<string, string | undefined>>,
  harness: Pick<WorkerHarness, "host" | "timers"> &
    Readonly<{ trace: WorkerTrace; delivery: SteeringDelivery }>,
): Promise<WorkerSteering | undefined> {
  const config = parseWorkerControlConfig(environment[WORKER_CONTROL_ENV]);
  if (config === undefined) return undefined;
  return WorkerSteering.open({
    host: harness.host,
    clock: SYSTEM_CLOCK,
    timers: harness.timers,
    config,
    readInbox: () => readTaskInbox(config.inboxPath),
    writeReceipt: (receipt) => writeWorkerReceipt(config.receiptPath, receipt),
    writeActivity: (activity) => writeWorkerActivity(config.receiptPath, activity),
    trace: harness.trace,
    delivery: harness.delivery,
  });
}
