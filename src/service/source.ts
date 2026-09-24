import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CommandRunner,
  IdFactory,
  Notification,
  TaskCommunicationView,
  TaskRecord,
  WorkerReceipt,
} from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState } from "../runtime/persistence.ts";
import type { RuntimeState, RuntimeTaskState } from "../runtime/schema.ts";
import {
  readTaskInbox,
  readWorkerReceipt,
  taskInboxPath,
  writeTaskInbox,
} from "../tasks/communication-persistence.ts";
import { appendTaskMessage, taskInbox } from "../tasks/communication-protocol.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { WorkerRole } from "../workers/jobs.ts";
import { isRecord, pathText, singleLine } from "./records.ts";

export type SourceWorkspace = Readonly<{
  readonly repoPath: string;
  readonly path: string;
}>;

export type TaskSource = Readonly<{
  readonly repoPath: string;
  readonly sourceRepoPath?: string;
  readonly checkoutPath: string;
}>;

async function gitCommonDirectory(run: CommandRunner, repoPath: string): Promise<string> {
  const result = await run({
    argv: ["git", "-C", repoPath, "rev-parse", "--git-common-dir"],
    cwd: repoPath,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `git common directory lookup failed with exit code ${result.code}${
        detail.length === 0 ? "" : `: ${detail}`
      }`,
    );
  }
  const commonPath = result.stdout.trim();
  if (commonPath.length === 0) throw new Error("git common directory lookup returned no path");
  return realpath(resolve(repoPath, commonPath));
}

export async function mapTaskSource(
  run: CommandRunner,
  repoPath: string,
  sourceWorkspace: SourceWorkspace | undefined,
): Promise<TaskSource> {
  const requestedPath = pathText(repoPath, "repoPath");
  if (sourceWorkspace === undefined) {
    return { repoPath: requestedPath, checkoutPath: resolve(requestedPath) };
  }
  const [originalRoot, sourceRoot, requestedRoot] = await Promise.all([
    realpath(sourceWorkspace.repoPath),
    realpath(sourceWorkspace.path),
    realpath(resolve(requestedPath)),
  ]);
  if (originalRoot === sourceRoot) {
    throw new Error("sourceWorkspace must identify a distinct clean checkout");
  }
  const [originalCommon, sourceCommon] = await Promise.all([
    gitCommonDirectory(run, originalRoot),
    gitCommonDirectory(run, sourceRoot),
  ]);
  if (originalCommon !== sourceCommon) {
    throw new Error(
      `sourceWorkspace original ${JSON.stringify(originalRoot)} and clean checkout ${JSON.stringify(sourceRoot)} do not share a Git common directory`,
    );
  }
  if (requestedRoot !== originalRoot && requestedRoot !== sourceRoot) {
    throw new Error(
      `repoPath ${JSON.stringify(requestedPath)} is not the configured original project or clean source checkout`,
    );
  }
  return {
    repoPath: originalRoot,
    sourceRepoPath: sourceRoot,
    checkoutPath: sourceRoot,
  };
}

export function taskSourcePath(task: TaskRecord, runtime?: RuntimeTaskState): string {
  return runtime?.sourceRepoPath ?? task.repoPath;
}

/** The checkout a task's worktree belongs to: its target repository's, else the coordinator's. */
export function taskCheckoutPath(task: TaskRecord): string {
  return task.target?.checkout ?? task.repoPath;
}

type SourceInboxDependencies = Readonly<{
  readonly home: string;
  readonly sourceWorkspace: SourceWorkspace | undefined;
  readonly run: CommandRunner;
  readonly clock: () => string;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
}>;

export class SourceInboxWorkflow {
  readonly #deps: SourceInboxDependencies;
  #scopeRepoPathPromise: Promise<string | undefined> | undefined;

  constructor(deps: SourceInboxDependencies) {
    this.#deps = deps;
  }

  async map(repoPath: string): Promise<TaskSource> {
    return mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
  }

  async repositoryScope(): Promise<string | undefined> {
    if (this.#scopeRepoPathPromise === undefined) {
      const requested = this.#deps.sourceWorkspace?.repoPath;
      this.#scopeRepoPathPromise =
        requested === undefined ? Promise.resolve(undefined) : realpath(requested);
    }
    return this.#scopeRepoPathPromise;
  }

  async taskInScope(task: TaskRecord, scopeOverride?: string): Promise<boolean> {
    const scope = scopeOverride ?? (await this.repositoryScope());
    if (scope === undefined) return true;
    return (await this.taskRepositoryPath(task.repoPath)) === scope;
  }

  taskRepositoryPath(repoPath: string): Promise<string | undefined> {
    return realpath(repoPath).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  async scopedTasks(): Promise<readonly TaskRecord[]> {
    const tasks = await this.#deps.store.list();
    const scope = await this.repositoryScope();
    if (scope === undefined) return tasks;
    const resolvedByRepoPath = new Map<string, Promise<string | undefined>>();
    const scoped: TaskRecord[] = [];
    for (const task of tasks) {
      let taskPath = resolvedByRepoPath.get(task.repoPath);
      if (taskPath === undefined) {
        taskPath = this.taskRepositoryPath(task.repoPath);
        resolvedByRepoPath.set(task.repoPath, taskPath);
      }
      if ((await taskPath) === scope) scoped.push(task);
    }
    return scoped;
  }

  async publishTaskInbox(task: TaskRecord): Promise<void> {
    if (task.communication === undefined) return;
    try {
      await writeTaskInbox(
        taskInboxPath(this.#deps.home, task.id),
        taskInbox(task.id, task.communication),
      );
    } catch {
      // Canonical communication is already durable; the next messages read repairs this projection.
    }
  }

  async repairTaskInbox(taskId: string): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (
        task === undefined ||
        !(await this.taskInScope(task)) ||
        task.communication === undefined
      ) {
        return;
      }
      const path = taskInboxPath(this.#deps.home, task.id);
      const expected = taskInbox(task.id, task.communication);
      try {
        const current = await readTaskInbox(path);
        if (JSON.stringify(current) !== JSON.stringify(expected))
          await writeTaskInbox(path, expected);
      } catch {
        await writeTaskInbox(path, expected);
      }
    });
  }

  async appendAnswer(
    taskId: string,
    questionId: string,
    textValue: string,
  ): Promise<{ readonly task: TaskRecord; readonly resumed: boolean }> {
    let result: { readonly task: TaskRecord; readonly resumed: boolean } | undefined;
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      if (task.stage === "cancelled" || task.stage === "merged") {
        throw new Error(`Task ${taskId} cannot be answered while it is ${task.stage}`);
      }
      const question = task.communication?.question;
      if (question?.id !== questionId) {
        throw new Error(`question ${questionId} is no longer current for task ${taskId}`);
      }
      const communication = appendTaskMessage(task.communication, {
        id: singleLine(this.#deps.idFactory(), "answer id"),
        kind: "answer",
        text: textValue,
        createdAt: this.#deps.clock(),
        replyTo: questionId,
      });
      // Answering clears `communication.question`, so the question's own wording would otherwise
      // be lost; keep it as an acknowledged, non-surfacing notification keyed by the question id so
      // a later review brief can pair it back up with this answer via the message's `replyTo`.
      const decision: Notification = {
        id: questionId,
        message: question.text,
        acknowledged: true,
        kind: "routine",
      };
      const answered = await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: this.#deps.clock(),
        communication,
        notifications: [...current.notifications, decision],
      }));
      await this.publishTaskInbox(answered);
      result = {
        task: answered,
        resumed:
          answered.stage === "blocked" &&
          answered.previousStage !== undefined &&
          answered.previousStage !== "paused" &&
          answered.previousStage !== "blocked",
      };
    });
    if (result === undefined) throw new Error(`answer for task ${taskId} was not saved`);
    return result;
  }

  async communicationView(task: TaskRecord): Promise<TaskCommunicationView> {
    const communication = task.communication;
    const allMessages = communication?.messages ?? [];
    const superseded = new Set<string>();
    for (const message of allMessages) {
      for (const id of message.supersedes ?? []) superseded.add(id);
    }
    const state: RuntimeState = await this.#deps.store.exclusive(() =>
      readRuntimeState(this.#deps.runtimePath),
    );
    const runtime = taskRuntime(state, task.id);
    const primaryRole: WorkerRole = task.kind === "scout" ? "scout" : "implementer";
    let activity: WorkerReceipt | undefined;
    if (runtime !== undefined) {
      const jobs = [...runtime.jobs]
        .filter(
          (job) =>
            job.kind === "worker" &&
            job.role === primaryRole &&
            job.generation === task.generation &&
            job.receiptPath !== undefined,
        )
        .reverse();
      for (const job of jobs) {
        const receipt = await readWorkerReceipt(job.receiptPath as string, {
          jobId: job.id,
          taskId: task.id,
          generation: job.generation,
        }).catch(() => undefined);
        if (receipt !== undefined) {
          activity = receipt;
          break;
        }
      }
    }
    const messages = allMessages.map((message) => ({
      ...message,
      status: superseded.has(message.id)
        ? ("superseded" as const)
        : activity === undefined
          ? ("pending" as const)
          : activity.appliedRevision >= message.revision
            ? ("applied" as const)
            : activity.receivedRevision >= message.revision
              ? ("received" as const)
              : ("pending" as const),
    }));
    return {
      taskId: task.id,
      stage: task.stage,
      revision: communication?.revision ?? 0,
      messages,
      ...(communication?.question === undefined ? {} : { question: communication.question }),
      ...(activity === undefined ? {} : { activity }),
    };
  }
}
