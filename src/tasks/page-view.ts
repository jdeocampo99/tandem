import { displayActivity } from "../board/panel.ts";
import type { FindingLedgerEntry, IsoTimestamp, TaskRecord, TaskStage } from "../contracts.ts";
import { harnessOfSelector } from "../harness/contract.ts";
import type { TodoItem } from "../playbooks/progress.ts";
import { elapsed } from "../pr-watch/view.ts";
import type { TaskCostView } from "../runtime/usage-view.ts";
import type { WorkerActivity } from "../workers/worker-activity.ts";
import { isUnvalidatedPolicy } from "./acceptance.ts";
import type { TaskInspection } from "./inspection.ts";
import type { StoredTimelineEvent } from "./timeline.ts";

export type TaskPageInput = Readonly<{
  task: TaskRecord;
  inspection: TaskInspection;
  timeline: readonly StoredTimelineEvent[];
  unreadableEvents: number;
  activity?: WorkerActivity;
  /** Model actually routed on the primary job; absent when no model is running. */
  model?: string;
  cost?: TaskCostView;
  now: IsoTimestamp;
}>;
export type StageStep = Readonly<{
  stage: TaskStage;
  label: string;
  state: "done" | "current" | "pending" | "skipped";
  round?: Readonly<{ used: number; max: number }>;
}>;
export type TaskPageView = Readonly<{
  header: Readonly<{
    id: string;
    title: string;
    stage: TaskStage;
    model?: string;
    harness?: string;
    elapsed: string;
    branch?: string;
    returnLabel: string;
  }>;
  rightNow: Readonly<{ text: string; since?: IsoTimestamp; age?: string }>;
  stageTrack: readonly StageStep[];
  tabs: readonly string[];
  overview: Readonly<{
    summary: string;
    todos: readonly TodoItem[];
    done: number;
    total: number;
    recent: readonly StoredTimelineEvent[];
  }>;
  progress: Readonly<{
    events: readonly StoredTimelineEvent[];
    unreadableEvents: number;
    checks: readonly Readonly<{ name: string; passed: boolean; head: string; contract: string }>[];
    findings: readonly FindingLedgerEntry[];
  }>;
  cost?: TaskCostView;
  stuck?: Readonly<{ reason: string; actions: readonly ["restart", "steer"] }>;
  requestId?: string;
  pullRequest?: TaskRecord["pullRequest"];
  message: Readonly<{ placeholder: string; model?: string }>;
}>;
const TRACK = [
  ["implementing", "Implement"],
  ["validating", "Validate"],
  ["reviewing", "Review"],
  ["awaiting-fixes", "Fix"],
  ["ready", "Ready"],
] as const;

export function taskPageView(input: TaskPageInput): TaskPageView {
  if (
    input.inspection.taskId !== input.task.id ||
    input.inspection.generation !== input.task.generation
  )
    throw new TypeError("Task inspection must match the task and generation");
  const { task, inspection, activity, model, now } = input;
  const events = input.timeline
    .filter((event) => event.taskId === task.id)
    .toSorted((a, b) => a.seq - b.seq);
  const todos = activity?.todos ?? [];
  const tool = displayActivity(activity, now);
  const track: readonly (readonly [TaskStage, string])[] =
    task.kind === "implementation"
      ? TRACK
      : [
          ["scouting", task.kind === "pr-review" ? "Review" : "Research"],
          ["completed", "Ready"],
        ];
  const stage =
    task.stage === "blocked" || task.stage === "paused" ? task.previousStage : task.stage;
  const visited = new Set(
    events.flatMap((event) =>
      event.type === "stage-changed"
        ? [event.from, event.to]
        : event.type === "created"
          ? [event.stage]
          : [],
    ),
  );
  return {
    header: {
      id: task.id,
      title: task.title ?? task.objective,
      stage: task.stage,
      elapsed: elapsed(task.createdAt, now),
      returnLabel: "← Orchestrator",
      ...(model === undefined ? {} : { model, harness: harnessOfSelector(model) }),
      ...(inspection.branch === undefined ? {} : { branch: inspection.branch }),
    },
    rightNow:
      tool === undefined || task.stage === "blocked"
        ? { text: task.blockCause?.summary ?? task.blockReason ?? stageWords(task.stage) }
        : {
            text: [tool.verb, tool.target].filter(Boolean).join(" "),
            ...(activity?.toolStartedAt === undefined
              ? {}
              : { since: activity.toolStartedAt, age: elapsed(activity.toolStartedAt, now) }),
          },
    stageTrack: track.map(([step, label]) => ({
      stage: step,
      // A project that chose no checks shows its skipped validation as unvalidated, never as passed.
      label:
        step === "validating" && isUnvalidatedPolicy(task.policy.config) ? "Unvalidated" : label,
      state:
        (step === "reviewing" && task.requiredStages?.review === false) ||
        (step === "validating" && task.requiredStages?.validation === false)
          ? "skipped"
          : step === stage
            ? "current"
            : visited.has(step) ||
                ((task.stage === "ready" || task.stage === "merged") && step !== "awaiting-fixes")
              ? "done"
              : "pending",
      ...(step === "awaiting-fixes"
        ? { round: { used: inspection.codeFixRounds.used, max: inspection.codeFixRounds.max } }
        : {}),
    })),
    tabs: ["Overview", "Brief", "Progress", "Diff", "PR", "Cost"],
    overview: {
      summary: task.objective,
      todos,
      done: todos.filter((todo) => todo.status === "completed").length,
      total: todos.length,
      recent: events.slice(-5).toReversed(),
    },
    progress: {
      events,
      unreadableEvents: input.unreadableEvents,
      checks: task.validationEvidence.map((check) => ({
        name: check.name,
        passed: check.exitCode === 0,
        head: check.head,
        contract: check.contract,
      })),
      findings: task.findingLedger ?? [],
    },
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    ...(task.stage !== "blocked"
      ? {}
      : {
          stuck: {
            reason:
              inspection.blockCause?.summary ??
              task.blockReason ??
              "The task stopped; restart it or send the worker guidance.",
            actions: ["restart", "steer"] as const,
          },
        }),
    ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
    ...(task.pullRequest === undefined ? {} : { pullRequest: task.pullRequest }),
    message: { placeholder: "Message the worker…", ...(model === undefined ? {} : { model }) },
  };
}
export function stageWords(stage: TaskStage): string {
  return (
    {
      scouting: "researching",
      implementing: "implementing",
      validating: "checking",
      reviewing: "in review",
      "awaiting-fixes": "fixing",
      ready: "ready to publish",
      blocked: "stuck",
      "awaiting-approval": "waiting for approval",
      queued: "waiting for a free worktree",
      paused: "paused by you",
      completed: "done",
      merged: "merged",
      cancelled: "cancelled",
    } satisfies Record<TaskStage, string>
  )[stage];
}
