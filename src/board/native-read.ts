import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { harnessOfSelector } from "../harness/contract.ts";
import { readOmpUsageLimits } from "../harness/omp/usage-limits.ts";
import { nativeCatchUpView } from "../memory/native-view.ts";
import { recordNativePublication } from "../memory/native-visits.ts";
import { listWorkstreams, memoryPath, memoryRoot } from "../memory/store.ts";
import { catchUpView, recentWork } from "../memory/workstream.ts";
import { publishViews, readProjectSummaries } from "../native/store.ts";
import { type CachedPullRequest, type PrPaneView, prPaneView } from "../pr-review/native-view.ts";
import { reviewPostNotes } from "../pr-review/render.ts";
import { latestRound, prReviewRunDiffPath } from "../pr-review/state.ts";
import { readNativePullRequest } from "../pr-watch/native-cache.ts";
import { withPrWatches } from "../pr-watch/store.ts";
import { briefView } from "../requests/native-view.ts";
import { createRequestBriefStore } from "../requests/store.ts";
import { activeRuntimeJob, currentPrimaryJobs, taskRuntime } from "../runtime/activity.ts";
import { withStateTransaction } from "../runtime/database.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import { usageDisplay } from "../runtime/usage-display.ts";
import { createRequestUsageLedger, readTaskUsage } from "../runtime/usage-ledger.ts";
import type { RequestUsageReadout } from "../runtime/usage-receipt.ts";
import {
  type AccountLimit,
  taskUsageView,
  usageView,
  usageWindowStarts,
} from "../runtime/usage-view.ts";
import { inspectTask } from "../tasks/inspection.ts";
import { taskPageView } from "../tasks/page-view.ts";
import { createTaskStore } from "../tasks/store.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import { taskCost } from "../tasks/trace.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { parseWorkerJob } from "../workers/jobs.ts";
import { readWorkerActivity } from "../workers/worker-activity.ts";
import { nativeBoardView } from "./native.ts";
import { NativeAlerts, nativeAlertCounts } from "./native-alerts.ts";
import {
  type NativeProjectSummary,
  type NativeViewsPublication,
  nativeBriefFile,
  nativeChangeSignature,
  nativePrFile,
  nativeSummaryProjects,
  nativeTaskFile,
} from "./native-views.ts";
import { type NativeTaskSummary, nativePanelView } from "./panel.ts";
import type { BoardSnapshot } from "./snapshot.ts";

export type NativeReadDependencies = Readonly<{
  home: string;
  clock: Clock;
  run: CommandRunner;
  terminal: TerminalBackend;
}>;
const REMOTE_REFRESH_MS = 60_000;

/** The project coordinator owns this reader/cache. Remote data refreshes at most once a minute. */
export class NativeViewsReader {
  readonly #deps: NativeReadDependencies;
  #limits: readonly AccountLimit[] = [];
  #limitsAttemptAt = Number.NEGATIVE_INFINITY;
  #limitsFailed = false;
  readonly #prs = new Map<string, CachedPullRequest>();
  readonly #attempts = new Map<string, number>();
  readonly #failures = new Set<string>();
  #remoteQueue: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #loading = new Set<string>();

  constructor(deps: NativeReadDependencies) {
    this.#deps = deps;
  }

  async read(
    snapshot: BoardSnapshot,
    project: string,
    /** Session id by repository, for coordinators that host native views. */
    sessions: ReadonlyMap<string, string> = new Map(),
  ): Promise<NativeViewsPublication> {
    const deps = this.#deps;
    const now = deps.clock();
    const clock = () => now;
    const tasks = createTaskStore({
      directory: join(deps.home, "tasks"),
      clock,
      idFactory: defaultIdFactory(),
    });
    const briefs = createRequestBriefStore({
      home: deps.home,
      clock,
      idFactory: defaultIdFactory(),
    });
    const ledger = createRequestUsageLedger({ home: deps.home, clock });
    const saved = await withStateTransaction(deps.home, async () => ({
      tasks: (await tasks.list()).filter((task) => task.repoPath === project),
      briefs: (await briefs.list()).filter((brief) => brief.repoPath === project),
      watches: await withPrWatches(deps.home, ({ watches }) =>
        watches.filter((watch) => watch.repoPath === project),
      ),
      runtime: await readRuntimeState(runtimeFile(deps.home)),
    }));
    const warnings: string[] = [];
    const pages: Record<string, ReturnType<typeof taskPageView>> = {};
    const finished: { taskId: string; at: string }[] = [];
    const summaries: NativeTaskSummary[] = [];
    const usageScopes = new Map<string, RequestUsageReadout>();
    for (const task of saved.tasks) {
      const scope = task.requestId ?? task.id;
      const readout = usageScopes.get(scope) ?? (await readTaskUsage(ledger, task));
      usageScopes.set(scope, readout);
      const runtime = taskRuntime(saved.runtime, task.id);
      const job =
        runtime?.jobs
          .toReversed()
          .find(
            (job) =>
              job.kind === "worker" && job.generation === task.generation && activeRuntimeJob(job),
          ) ?? currentPrimaryJobs(task, runtime)[0];
      let model: string | undefined;
      if (job !== undefined) {
        try {
          const worker = parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8")));
          if (worker.taskId === task.id && worker.generation === task.generation)
            model = worker.model.model;
        } catch {
          warnings.push(`Model unavailable for ${task.id}`);
        }
      }
      const activity =
        job?.receiptPath === undefined ? undefined : await readWorkerActivity(job.receiptPath);
      const inspection = await inspectTask(
        { run: deps.run, terminal: deps.terminal, runtimePath: runtimeFile(deps.home) },
        task,
      );
      const timeline = await readTimeline(deps.home, task.id);
      const finish = timeline.events.find(
        (event) =>
          event.type === "stage-changed" &&
          (event.to === "ready" || event.to === "completed" || event.to === "merged"),
      );
      if (finish !== undefined) finished.push({ taskId: task.id, at: finish.at });
      pages[task.id] = taskPageView({
        task,
        inspection,
        timeline: timeline.events,
        unreadableEvents: timeline.unreadableEvents,
        now,
        cost: taskUsageView(task.id, readout),
        ...(activity === undefined ? {} : { activity }),
        ...(model === undefined ? {} : { model }),
      });
      const cost = taskCost(readout, task.id);
      summaries.push(taskSummary(task, model, inspection.branch, cost));
    }
    const references = [
      ...new Map([
        ...saved.watches
          .filter((watch) => watch.finishedAt === undefined && watch.stoppedAt === undefined)
          .map((watch) => [`${watch.ref.repo}#${watch.ref.number}`, watch.ref] as const),
        ...saved.tasks.flatMap((task) =>
          task.pullRequest === undefined ||
          task.pullRequest.state === "merged" ||
          task.pullRequest.state === "closed" ||
          task.stage === "cancelled"
            ? []
            : [
                [
                  `${task.pullRequest.repository}#${task.pullRequest.number}`,
                  { repo: task.pullRequest.repository, number: task.pullRequest.number },
                ] as const,
              ],
        ),
        ...saved.tasks.flatMap((task) =>
          task.prReview === undefined || task.prReview.closed === true
            ? []
            : [
                [
                  `${task.prReview.ref.repo}#${task.prReview.ref.number}`,
                  task.prReview.ref,
                ] as const,
              ],
        ),
      ]).values(),
    ];
    const prViews: Record<string, PrPaneView> = {};
    for (const ref of references) {
      const key = `${ref.repo}#${ref.number}`;
      if (
        !this.#closed &&
        !this.#loading.has(key) &&
        Date.parse(now) - (this.#attempts.get(key) ?? Number.NEGATIVE_INFINITY) >= REMOTE_REFRESH_MS
      ) {
        this.#attempts.set(key, Date.parse(now));
        this.#loading.add(key);
        this.enqueue(async () => {
          try {
            this.#prs.set(key, await readNativePullRequest(deps.run, ref, project, deps.clock()));
            this.#failures.delete(key);
          } catch {
            this.#failures.add(key);
          } finally {
            this.#loading.delete(key);
          }
        });
      }
      if (this.#loading.has(key)) warnings.push(`GitHub cache is refreshing for ${key}`);
      if (this.#failures.has(key)) warnings.push(`GitHub cache refresh failed for ${key}`);
      let cached = this.#prs.get(key);
      if (cached === undefined) continue;
      const task = saved.tasks.find(
        (task) => task.prReview?.ref.repo === ref.repo && task.prReview.ref.number === ref.number,
      );
      const round = task?.prReview === undefined ? undefined : latestRound(task.prReview);
      let review: PrPaneView["review"];
      if (task !== undefined && round !== undefined) {
        try {
          cached = {
            ...cached,
            threads: cached.head === round.head ? cached.threads : [],
            checks: cached.head === round.head ? cached.checks : [],
            head: round.head,
            patch: await readFile(
              prReviewRunDiffPath(deps.home, task.id, round.generation),
              "utf8",
            ),
            tour: round.review.tour,
          };
          review = {
            taskId: task.id,
            generation: round.generation,
            head: round.head,
            currentHead: this.#prs.get(key)?.head ?? round.head,
            posted: round.posted !== undefined,
            intent: round.review.intent,
            summary: round.review.summaryComment,
            drafts: round.review.comments,
            concerns: round.review.concerns,
            notes: reviewPostNotes(cached.url, round),
            ...(round.review.verdict === undefined ? {} : { verdict: round.review.verdict }),
          };
        } catch {
          warnings.push(`Reviewed diff unavailable for ${task.id}`);
        }
      }
      const watch = saved.watches.find(
        (watch) => watch.ref.repo === ref.repo && watch.ref.number === ref.number,
      );
      const linkedTask = saved.tasks.find(
        (task) =>
          task.pullRequest?.repository === ref.repo && task.pullRequest.number === ref.number,
      );
      prViews[key] = prPaneView({
        ...(linkedTask === undefined ? {} : { taskId: linkedTask.id }),
        cached,
        ...(watch === undefined ? {} : { watch }),
        ...(review === undefined ? {} : { review }),
      });
    }
    if (
      !this.#closed &&
      !this.#loading.has("limits") &&
      Date.parse(now) - this.#limitsAttemptAt >= REMOTE_REFRESH_MS
    ) {
      this.#limitsAttemptAt = Date.parse(now);
      this.#loading.add("limits");
      this.enqueue(async () => {
        try {
          this.#limits = await readOmpUsageLimits(deps.run, project);
          this.#limitsFailed = false;
        } catch {
          this.#limitsFailed = true;
        } finally {
          this.#loading.delete("limits");
        }
      });
    }
    if (this.#loading.has("limits")) warnings.push("Provider limits are refreshing");
    if (this.#limitsFailed)
      warnings.push("Provider limit refresh failed; last known limits may be stale");
    const scopes = [...usageScopes.values()];
    const usage = usageView({
      now,
      ...usageWindowStarts(now),
      finished,
      limits: this.#limits,
      readout: {
        events: scopes.flatMap((scope) => scope.events),
        malformedEvents: scopes.reduce((sum, scope) => sum + scope.malformedEvents, 0),
      },
    });
    const root = await memoryRoot(project, deps.home);
    const workstreams = await listWorkstreams(root);
    const catchups = workstreams.map((workstream) =>
      catchUpView({
        ...workstream,
        path: memoryPath(root, workstream.memory.name),
        now,
        recent: recentWork(saved.tasks, saved.watches, workstream.memory.name),
      }),
    );
    const ownPanel = nativePanelView({ snapshot, project, now, tasks: summaries, bellCount: 0 });
    const count = (title: string) =>
      ownPanel.sections.find((section) => section.title === title)?.count ?? 0;
    const sessionId = sessions.get(project);
    const summary: NativeProjectSummary = {
      repoPath: project,
      name: basename(project),
      writtenAt: now,
      running: count("Running"),
      needsYou: count("Needs you"),
      ready: count("Ready"),
      done: count("Recently done"),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    const other = await readProjectSummaries(deps.home, project);
    warnings.push(...other.warnings);
    const projects = nativeSummaryProjects([summary, ...other.summaries], project, now);
    const briefViews = Object.fromEntries(
      saved.briefs.map((brief) => [brief.id, briefView(brief)]),
    );
    const fiveHour = usage.limits
      .filter((limit) => limit.window === "five-hour")
      .toSorted(
        (a, b) =>
          (typeof a.remainingPercent === "number" ? a.remainingPercent : 101) -
          (typeof b.remainingPercent === "number" ? b.remainingPercent : 101),
      )[0];
    return {
      retainedDetailFiles: references.map((ref) => nativePrFile(ref.repo, ref.number)),
      details: [
        ...Object.entries(pages).map(([id, data]) => ({
          file: nativeTaskFile(id),
          view: { version: 1 as const, project, kind: "task" as const, data },
        })),
        ...Object.entries(briefViews).map(([id, data]) => ({
          file: nativeBriefFile(id),
          view: { version: 1 as const, project, kind: "brief" as const, data },
        })),
        ...Object.entries(prViews).map(([, data]) => ({
          file: nativePrFile(data.header.repo, data.header.number),
          view: { version: 1 as const, project, kind: "pr" as const, data },
        })),
      ],
      bundle: {
        version: 1,
        project,
        writtenAt: now,
        summary,
        changeSignature: nativeChangeSignature({
          tasks: saved.tasks.map((task) => ({
            id: task.id,
            stage: task.stage,
            generation: task.generation,
            reviewRound: task.reviewRound,
            ...(task.communication?.question === undefined
              ? {}
              : { questionId: task.communication.question.id }),
            ...(task.blockReason === undefined ? {} : { blockReason: task.blockReason }),
            ...(task.pullRequest === undefined ? {} : { pullRequest: task.pullRequest }),
          })),
          briefs: saved.briefs.map((brief) => ({
            id: brief.id,
            revision: brief.draft.revision,
            contentDigest: brief.draft.contentDigest,
            approvalState: briefView(brief).approvalState,
          })),
          workstreams: workstreams.map((workstream) => ({
            name: workstream.memory.name,
            savedAt: workstream.savedAt,
          })),
          pullRequests: saved.watches.map((watch) => ({
            key: `${watch.ref.repo}#${watch.ref.number}`,
            ...(watch.head === undefined ? {} : { head: watch.head.oid }),
            ...(watch.row === undefined ? {} : { status: watch.row.status, note: watch.row.note }),
          })),
        }),
        panel: nativePanelView({
          snapshot,
          project,
          now,
          tasks: summaries,
          projects,
          bellCount: (await nativeAlertCounts(deps.home, project)).unread,
          ...(fiveHour === undefined ? {} : { fiveHour }),
        }),
        projects,
        tasks: Object.fromEntries(
          summaries.map((task) => [
            task.taskId,
            { ...task, detailFile: nativeTaskFile(task.taskId) },
          ]),
        ),
        briefs: Object.fromEntries(
          Object.entries(briefViews).map(([id, brief]) => [
            id,
            {
              requestId: brief.requestId,
              title: brief.title,
              revision: brief.revision,
              changes: brief.changes,
              approvalState: brief.approvalState,
              abandoned: brief.abandoned,
              commentCount: brief.commentCount,
              detailFile: nativeBriefFile(id),
            },
          ]),
        ),
        pullRequests: Object.fromEntries(
          Object.entries(prViews).map(([key, pr]) => [
            key,
            {
              header: pr.header,
              readAt: pr.readAt,
              detailFile: nativePrFile(pr.header.repo, pr.header.number),
            },
          ]),
        ),
        board: nativeBoardView(snapshot, project, summaries, now),
        usage: { ...usage, display: usageDisplay(usage, { writtenAt: now, warnings }) },
        catchup: nativeCatchUpView(
          project,
          catchups,
          snapshot.board.needsYou.filter((row) => row.repoPath === project),
          [
            ...saved.tasks
              .filter(
                (task) =>
                  task.pullRequest !== undefined &&
                  (task.stage === "merged" || task.pullRequest.state === "merged"),
              )
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .flatMap((task) =>
                task.pullRequest === undefined
                  ? []
                  : [
                      {
                        number: task.pullRequest.number,
                        title: task.pullRequest.title ?? task.title ?? task.objective,
                        url:
                          task.pullRequest.url ??
                          `https://github.com/${task.pullRequest.repository}/pull/${task.pullRequest.number}`,
                        state: "merged" as const,
                      },
                    ],
              ),
            ...saved.watches
              .filter(
                (watch) =>
                  watch.mergedAt !== undefined || watch.row?.status.startsWith("🎉") === true,
              )
              .map((watch) => ({
                number: watch.ref.number,
                title: watch.summary?.title ?? `#${watch.ref.number}`,
                url:
                  watch.summary?.url ??
                  `https://github.com/${watch.ref.repo}/pull/${watch.ref.number}`,
                state: "merged" as const,
              })),
          ],
        ),
        warnings,
      },
    };
  }

  /** Resolves once the remote reads started so far have finished; later reads still refresh. */
  async idle(): Promise<void> {
    let queue: Promise<void>;
    do {
      queue = this.#remoteQueue;
      await queue;
    } while (queue !== this.#remoteQueue);
  }

  /** Service shutdown drains the read-only remote work; no refresh starts after this call. */
  async settle(): Promise<void> {
    this.#closed = true;
    await this.idle();
  }

  private enqueue(operation: () => Promise<void>): void {
    this.#remoteQueue = this.#remoteQueue.then(operation);
  }
}

function taskSummary(
  task: TaskRecord,
  model: string | undefined,
  branch: string | undefined,
  cost: ReturnType<typeof taskCost>,
): NativeTaskSummary {
  const pr = task.pullRequest;
  return {
    taskId: task.id,
    title: task.title ?? task.objective,
    stage: task.stage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.previousStage === undefined ? {} : { previousStage: task.previousStage }),
    ...(model === undefined ? {} : { model, harness: harnessOfSelector(model) }),
    ...(branch === undefined ? {} : { branch }),
    ...(cost === undefined ? {} : { costMicros: cost.amountMicros }),
    unpricedSamples: cost?.unavailableSamples ?? 0,
    ...(task.quick === undefined ? {} : { quick: true }),
    ...(pr === undefined
      ? {}
      : {
          pullRequest: {
            repo: pr.repository,
            number: pr.number,
            draft: pr.state === "draft",
            url: pr.url ?? `https://github.com/${pr.repository}/pull/${pr.number}`,
          },
        }),
  };
}

type PublicationInput = Readonly<{
  snapshot: BoardSnapshot;
  project: string;
  sessions: ReadonlyMap<string, string>;
}>;

/** One background writer per coordinator. Slow reads coalesce ticks to the newest snapshot. */
export class NativeViewsPublisher {
  readonly #deps: NativeReadDependencies;
  readonly #reader: NativeViewsReader;
  readonly #alerts: NativeAlerts;
  #pending: PublicationInput | undefined;
  #running: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;

  constructor(deps: NativeReadDependencies) {
    this.#deps = deps;
    this.#reader = new NativeViewsReader(deps);
    this.#alerts = new NativeAlerts(deps);
  }

  schedule(input: PublicationInput): void {
    if (this.#closed) return;
    this.#pending = input;
    if (this.#busy) return;
    this.#busy = true;
    this.#running = Promise.resolve().then(async () => {
      try {
        while (this.#pending !== undefined) {
          const next = this.#pending;
          this.#pending = undefined;
          try {
            const sessionId = next.sessions.get(next.project);
            if (sessionId !== undefined) {
              await this.#recoverOpens();
              await this.#alerts.observe(next.snapshot, next.project, sessionId);
            }
            const view = await publishViews(this.#deps.home, next.project, () =>
              this.#reader.read(next.snapshot, next.project, next.sessions),
            );
            await recordNativePublication({
              home: this.#deps.home,
              project: next.project,
              signature: view.bundle.changeSignature,
            });
          } catch (error) {
            await appendDiagnosticEvent(
              this.#deps.home,
              {
                event: "native-views-publish-failed",
                details: { errorClass: error instanceof Error ? error.name : typeof error },
              },
              this.#deps.clock,
            );
          }
        }
      } finally {
        this.#busy = false;
      }
    });
  }

  /** A late receipt settles its paused open here, without waiting for the user's next click. */
  async #recoverOpens(): Promise<void> {
    try {
      await this.#deps.terminal.views?.recover(this.#deps.home);
    } catch (error) {
      await appendDiagnosticEvent(
        this.#deps.home,
        {
          event: "native-open-recovery-failed",
          details: { errorClass: error instanceof Error ? error.name : typeof error },
        },
        this.#deps.clock,
      );
    }
  }

  /** Resolves once queued publications and the remote reads they started have finished. */
  async idle(): Promise<void> {
    let running: Promise<void>;
    do {
      running = this.#running;
      await running;
    } while (running !== this.#running);
    await this.#reader.idle();
  }

  /** Finish the last queued publication, then drain provider/GitHub cache reads. */
  async settle(): Promise<void> {
    this.#closed = true;
    await this.#running;
    await this.#reader.settle();
  }
}
