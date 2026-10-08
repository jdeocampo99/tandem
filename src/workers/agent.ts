import { dirname } from "node:path";
import type { CommandRunner } from "../contracts.ts";
import type { AgentKind, Harness, LaunchIo, StartedAgent } from "../harness/contract.ts";
import { readTaskInbox } from "../tasks/communication-persistence.ts";
import { formatTaskMessages } from "../tasks/communication-protocol.ts";
import type { RunInteractive } from "../terminal/cli-process.ts";
import { WORKER_CONTROL_ENV } from "./control-protocol.ts";
import type { WorkerJob } from "./jobs.ts";
import { WORKER_JOB_PATH_ENV } from "./terminal.ts";

export type WorkerAgentDependencies = Readonly<{
  run: RunInteractive;
  runCommand: CommandRunner;
  /** Resolve only after setup and inbox checks have succeeded. */
  launchContext: () => Readonly<{ io: LaunchIo; home: string }>;
}>;

async function promptWithInitialCommunication(job: WorkerJob): Promise<string> {
  if (job.communication === undefined) return job.prompt;
  const inbox = await readTaskInbox(job.communication.inboxPath);
  if (inbox === undefined) {
    if (job.communication.initialRevision > 0) {
      throw new Error("configured task communication inbox is missing");
    }
    return job.prompt;
  }
  if (inbox.taskId !== job.taskId) {
    throw new Error("configured task communication inbox belongs to a different task");
  }
  if (inbox.revision < job.communication.initialRevision) {
    throw new Error("configured task communication inbox is older than the worker snapshot");
  }
  if (inbox.revision === 0 || inbox.messages.length === 0) return job.prompt;
  const marker = formatTaskMessages(job.taskId, inbox.revision, inbox.messages);
  return job.prompt.includes(marker) ? job.prompt : `${job.prompt}\n\n${marker}`;
}

function workerEnvironment(job: WorkerJob, jobPath: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { [WORKER_JOB_PATH_ENV]: jobPath };
  if (job.communication !== undefined) {
    environment[WORKER_CONTROL_ENV] = JSON.stringify({
      schemaVersion: 1,
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
      inboxPath: job.communication.inboxPath,
      receiptPath: job.communication.receiptPath,
      initialRevision: job.communication.initialRevision,
    });
  }
  return environment;
}

type AgentRequest = Parameters<RunInteractive>[0];

/** The project's own checkout, which Claude Code's trust covers; the worktree when git can't say. */
async function projectCheckout(cwd: string, run: CommandRunner): Promise<string> {
  try {
    const result = await run({
      argv: ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    });
    return result.code === 0 ? dirname(result.stdout.trim()) : cwd;
  } catch {
    return cwd;
  }
}

/**
 * Runs the agent with its ready wait beside it. An agent that never loads Tandem is stopped and
 * the job fails with the harness's reason; one that exits first ends the wait.
 */
async function runWhenReady(
  launch: Readonly<{
    harness: Harness;
    request: AgentRequest;
    started: StartedAgent;
    io: LaunchIo;
  }>,
  run: RunInteractive,
): Promise<number> {
  const { harness, request, started, io } = launch;
  const stop = new AbortController();
  const exited = new AbortController();
  const outcome = run({ ...request, signal: stop.signal }).then(
    (code) => ({ ok: true as const, code }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void outcome.then(() => exited.abort());
  try {
    await harness.awaitReady(started, io, exited.signal);
  } catch (error) {
    stop.abort();
    await outcome;
    throw error;
  }
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.code;
}

/**
 * Prepares the worktree (e.g. installs dependencies) in the worker's own pane so the output is
 * visible and the coordinator never blocks on it. Reruns on every launch; installers are idempotent.
 */
async function runSetup(job: WorkerJob, run: RunInteractive): Promise<void> {
  for (const command of job.setup ?? []) {
    const exit = await run({ argv: command.argv, cwd: job.cwd, timeoutMs: command.timeoutMs });
    if (exit !== 0) {
      throw new Error(
        `worktree setup command ${JSON.stringify(command.name)} (${command.argv.join(" ")}) exited with code ${exit}`,
      );
    }
  }
}

export async function runWorkerAgent(
  input: Readonly<{ job: WorkerJob; jobPath: string; harness: Harness }>,
  deps: WorkerAgentDependencies,
): Promise<number> {
  const { job, jobPath, harness } = input;
  await runSetup(job, deps.run);
  const prompt = await promptWithInitialCommunication(job);
  const { io, home } = deps.launchContext();
  const conversation = await harness.conversation(
    { home, directory: job.sessionDirectory, resume: true, cwd: job.cwd },
    io,
  );
  const agent: AgentKind = job.prReview === undefined ? job.role : "pr-reviewer";
  const request: AgentRequest = {
    argv: harness.command({ agent, cwd: job.cwd, model: job.model, conversation, prompt }),
    cwd: job.cwd,
    env: { ...harness.launchEnvironment, ...workerEnvironment(job, jobPath) },
    unset: harness.clearedEnvironment,
  };
  const started: StartedAgent = {
    agent,
    home,
    repo: await projectCheckout(job.cwd, deps.runCommand),
    conversation,
  };
  return runWhenReady({ harness, request, started, io }, deps.run);
}
