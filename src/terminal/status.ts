import type { CommandRunner, TaskRecord, TaskStage } from "../contracts.ts";
import { listCoordinatorRecords } from "../coordinator/registry.ts";
import type { TandemService } from "../service/controller.ts";

const NEEDS_YOU: readonly TaskStage[] = ["awaiting-approval", "blocked", "paused", "ready"];
const WORKING: readonly TaskStage[] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];

export type TandemStatus = Readonly<{
  readonly code: string;
  readonly coordinators: readonly string[];
  readonly tasks: readonly TaskRecord[];
}>;

/** The commit the `tandem` command runs from; `tandem update` loads this into coordinators. */
export async function tandemCodeVersion(run: CommandRunner, tandemRoot: string): Promise<string> {
  const result = await run({
    argv: ["git", "-C", tandemRoot, "log", "-1", "--format=%h %s"],
    cwd: tandemRoot,
  });
  const version = result.code === 0 ? result.stdout.trim() : "";
  return `${version.length > 0 ? version : "unknown commit"} (${tandemRoot})`;
}

export async function readTandemStatus(
  input: Readonly<{
    readonly run: CommandRunner;
    readonly tandemRoot: string;
    readonly home: string;
    readonly sessionId: string;
    readonly service: TandemService;
  }>,
): Promise<TandemStatus> {
  return {
    code: await tandemCodeVersion(input.run, input.tandemRoot),
    coordinators: (await listCoordinatorRecords(input.home, input.sessionId)).map(
      (record) => record.repoPath,
    ),
    tasks: await input.service.list(),
  };
}

function taskLine(task: TaskRecord): string {
  const objective = task.objective.replace(/\s+/gu, " ");
  const short = objective.length > 70 ? `${objective.slice(0, 69)}…` : objective;
  const reason = task.stage === "blocked" && task.blockReason ? `\n      ${task.blockReason}` : "";
  return `  ${task.id}  ${task.stage}  ${short}${reason}`;
}

export function renderTandemStatus(status: TandemStatus): string {
  const needsYou = status.tasks.filter((task) => NEEDS_YOU.includes(task.stage));
  const working = status.tasks.filter((task) => WORKING.includes(task.stage));
  const finished = status.tasks.length - needsYou.length - working.length;
  const lines = [
    `Tandem code: ${status.code}`,
    "",
    status.coordinators.length === 0 ? "No coordinators are open. Run `tandem`." : "Coordinators:",
    ...status.coordinators.map((repo) => `  ${repo}`),
    "",
    needsYou.length === 0 ? "Nothing needs you." : "Needs you:",
    ...needsYou.map(taskLine),
    ...(working.length === 0 ? [] : ["", "Working:", ...working.map(taskLine)]),
    ...(finished === 0
      ? []
      : ["", `${finished} finished task${finished === 1 ? "" : "s"} hidden.`]),
    "",
    "Details for one task: tandem status TASK_ID",
  ];
  return `${lines.join("\n")}\n`;
}
