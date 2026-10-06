import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TaskKind, TaskStage } from "../contracts.ts";
import type { ReconcileReport, ReconcileReportEntry } from "../coordinator/reconcile.ts";
import type { RenestReport } from "../coordinator/renest.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { databasePath } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import { createTaskStore } from "../tasks/store.ts";

/** What the short `tandem fix` view needs about one task beyond the report's ids. */
export type FixTaskDetail = Readonly<{
  readonly title: string;
  readonly kind: TaskKind;
  readonly stage: TaskStage;
  readonly worktreePath?: string;
}>;

export type FixDetails = Readonly<{
  readonly tasks: ReadonlyMap<string, FixTaskDetail>;
  /** Which task holds each worktree lease, so a lease is shown on its task's line. */
  readonly leaseTasks: ReadonlyMap<string, string>;
}>;

export const NO_FIX_DETAILS: FixDetails = { tasks: new Map(), leaseTasks: new Map() };

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/u;

/** A ticket key such as TAG-1036 when the objective names one, else the objective shortened. */
export function taskTitle(kind: TaskKind, objective: string): string {
  const ticket = TICKET_KEY.exec(objective)?.[0];
  const flat = objective.replace(/\s+/gu, " ").trim();
  const short = ticket ?? (flat.length > 32 ? `${flat.slice(0, 31)}…` : flat);
  return kind === "scout" ? `${short} research` : short;
}

/** Reads task titles, stages, and worktrees for the human view; never changes anything. */
export async function readFixDetails(home: string): Promise<FixDetails> {
  try {
    if (!(await lstat(databasePath(home))).isFile()) return NO_FIX_DETAILS;
  } catch {
    return NO_FIX_DETAILS;
  }
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => new Date().toISOString(),
    idFactory: defaultIdFactory(),
  });
  const state = await readRuntimeState(runtimeFile(home));
  const tasks = new Map<string, FixTaskDetail>();
  const leaseTasks = new Map<string, string>();
  for (const task of await store.list()) {
    const worktree = taskRuntime(state, task.id)?.worktree ?? task.worktree;
    tasks.set(task.id, {
      title: taskTitle(task.kind, task.objective),
      kind: task.kind,
      stage: task.stage,
      ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
    });
    if (worktree !== undefined) leaseTasks.set(worktree.leaseId, task.id);
  }
  return { tasks, leaseTasks };
}

function stagePhrase(task: FixTaskDetail): string {
  if (task.stage === "cancelled")
    return task.kind === "implementation" ? "cancelled attempt" : "cancelled";
  if (task.stage === "completed") return "done";
  if (task.stage === "ready") return "ready to publish";
  return task.stage.replace(/-/gu, " ");
}

/** A Treehouse lease path ends in `<pool>/<slot>/<repo>`; the slot is the worktree number. */
function worktreeSlot(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const slot = basename(dirname(path));
  return /^\d+$/u.test(slot) ? slot : undefined;
}

function repoName(entry: ReconcileReportEntry): string {
  return entry.repoPath === undefined ? "" : ` · ${basename(entry.repoPath)}`;
}

function changesPhrase(reason: string): string | undefined {
  if (reason.includes("uncommitted")) return "has uncommitted changes";
  if (reason.includes("unmerged")) return "has unmerged files";
  return undefined;
}

function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/gu, " ");
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
}

type Outcome = "cleaned" | "retained" | "quarantined" | "failed" | "freeable";
type Row = readonly string[];

function taskRow(id: string, task: FixTaskDetail | undefined, fallbackLabel: string): Row {
  const slot = worktreeSlot(task?.worktreePath);
  return [
    task === undefined ? fallbackLabel : `${task.title} · ${stagePhrase(task)}`,
    id.slice(0, 8),
    ...(slot === undefined ? [] : [`worktree ${slot}`]),
  ];
}

function entryRow(entry: ReconcileReportEntry, outcome: Outcome, details: FixDetails): Row {
  const why = outcome === "quarantined" || outcome === "failed";
  if (isTask(entry)) {
    const row = taskRow(entry.id, details.tasks.get(entry.id), "Task");
    if (why) return [...row, shortReason(entry.reason)];
    if (entry.containedIn !== undefined) {
      // A task whose extra commits all came from main carries nothing of its own.
      const work =
        entry.containedIn === "main" ? "only main's commits" : `work is in ${entry.containedIn}`;
      return [...row, outcome === "cleaned" ? `freed · ${work}` : work];
    }
    if (entry.worktreeStays !== undefined && outcome === "cleaned") {
      return [...row, `stays: ${entry.worktreeStays}`];
    }
    return row;
  }
  if (entry.kind === "worktree-lease") {
    const taskId = details.leaseTasks.get(entry.id);
    if (taskId !== undefined && !why) {
      return taskRow(taskId, details.tasks.get(taskId), "Task");
    }
    const slot = worktreeSlot(entry.path);
    const label = `${slot === undefined ? "Worktrees" : `Worktree ${slot}`}${repoName(entry)}`;
    if (why) return [label, shortReason(entry.reason)];
    if (outcome === "cleaned") return [label, "left by a stopped coordinator"];
    return [label, changesPhrase(entry.reason) ?? "in use"];
  }
  if (entry.kind === "coordinator") {
    const label = `Coordinator${repoName(entry)}`;
    if (why) return [label, shortReason(entry.reason)];
    if (outcome === "cleaned") return [label, "stopped"];
    if (entry.reason.startsWith("a coordinator is running")) return [label, "running"];
    return [label, changesPhrase(entry.reason) ?? "stopped, worktree kept"];
  }
  if (entry.kind === "unreadable-record") {
    return ["Unreadable coordinator record", shortReason(entry.reason)];
  }
  if (entry.kind === "native-open") {
    const label = "Paused Tern view";
    if (outcome === "cleaned") return [label, "unproven open record · panes kept"];
    return [label, shortReason(entry.reason)];
  }
  if (outcome === "cleaned") return ["Old note about a returned worktree"];
  return [`Note about a held worktree${repoName(entry)}`, shortReason(entry.reason)];
}

/**
 * One row per thing. A task-held lease appears only on its task's line, as the worktree number,
 * so a task and the worktree it holds are never listed twice.
 */
function sectionRows(
  entries: readonly ReconcileReportEntry[],
  outcome: Outcome,
  details: FixDetails,
  listedTasks: ReadonlySet<string>,
): readonly Row[] {
  const rows: Row[] = [];
  const shownTasks = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "worktree-lease" && outcome !== "quarantined" && outcome !== "failed") {
      const taskId = details.leaseTasks.get(entry.id);
      if (taskId !== undefined && (listedTasks.has(taskId) || shownTasks.has(taskId))) continue;
      if (taskId !== undefined) shownTasks.add(taskId);
    }
    rows.push(entryRow(entry, outcome, details));
  }
  return rows;
}

export type FixSection = Readonly<{ readonly title: string; readonly rows: readonly Row[] }>;

/** Groups the report into the short sections the default view prints. */
export function fixSections(report: ReconcileReport, details: FixDetails): readonly FixSection[] {
  const dryRun = report.mode === "dry-run";
  const listedTasks = new Set(
    [
      ...report.cleaned,
      ...report.retained,
      ...report.quarantined,
      ...report.failed,
      ...report.freeable,
    ]
      .filter(isTask)
      .map((entry) => entry.id),
  );
  const rows = (entries: readonly ReconcileReportEntry[], outcome: Outcome) =>
    sectionRows(entries, outcome, details, listedTasks);
  return [
    { title: dryRun ? "Clean up" : "Cleaned", rows: rows(report.cleaned, "cleaned") },
    { title: "Can also free", rows: rows(report.freeable, "freeable") },
    { title: dryRun ? "Keep" : "Kept", rows: rows(report.retained, "retained") },
    { title: "Left alone", rows: rows(report.quarantined, "quarantined") },
    { title: "Failed", rows: rows(report.failed, "failed") },
  ];
}

function renderRows(rows: readonly Row[], widths: readonly number[]): readonly string[] {
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("   ")}`,
  );
}

function isTask(entry: ReconcileReportEntry): boolean {
  return entry.kind === "implementation-task" || entry.kind === "scout-task";
}

/** How many lines the confirmation question counts, matching the "Clean up" section. */
export function fixCleanupCount(report: ReconcileReport, details: FixDetails): number {
  return fixSections(report, details)[0]?.rows.length ?? 0;
}

/** The default `tandem fix` view: one line per thing, details behind `--verbose`. */
export function renderFixReport(report: ReconcileReport, details: FixDetails): string {
  const dryRun = report.mode === "dry-run";
  const unfinished = report.retained.some(isTask);
  const sections = fixSections(report, details).filter((section) => section.rows.length > 0);
  if (
    report.cleaned.length === 0 &&
    report.quarantined.length === 0 &&
    report.failed.length === 0 &&
    report.freeable.length === 0 &&
    !unfinished
  ) {
    return "Tandem fix · nothing to clean up\n";
  }
  const widths: number[] = [];
  for (const row of sections.flatMap((section) => section.rows)) {
    row.forEach((cell, index) => {
      if (index < row.length - 1) widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const lines = [dryRun ? "Tandem fix · nothing changed yet" : "Tandem fix · done"];
  for (const section of sections) {
    lines.push(
      "",
      `${section.title} (${section.rows.length})`,
      ...renderRows(section.rows, widths),
    );
  }
  lines.push("");
  // Implementation lines already say whether their worktree stays; scouts decide at cleanup time.
  const scoutWorktree = report.cleaned.some(
    (entry) =>
      entry.kind === "scout-task" && details.tasks.get(entry.id)?.worktreePath !== undefined,
  );
  if (dryRun && scoutWorktree) {
    lines.push("A research worktree is returned only if it is clean and still on its source.");
  }
  if (unfinished) lines.push("Some task cleanups did not finish, so their worktrees stay.");
  if (report.freeable.length > 0) {
    lines.push("Freeing returns a worktree but keeps its branch, so no commit is lost.");
    if (!dryRun) lines.push("To free them: tandem fix --yes --free-superseded");
  } else if (report.cleaned.some((entry) => isTask(entry) && entry.containedIn !== undefined)) {
    lines.push("Freed worktrees keep their branches, so no commit is lost.");
  }
  lines.push("tandem fix --verbose shows paths and reasons");
  return `${lines.join("\n")}\n`;
}

function verboseSection(
  title: string,
  entries: readonly ReconcileReportEntry[],
): readonly string[] {
  if (entries.length === 0) return [];
  return [
    "",
    `${title} ${entries.length} resource${entries.length === 1 ? "" : "s"}:`,
    ...entries.map((entry) => {
      const where = entry.path ?? entry.repoPath;
      const suffix = where === undefined || where === entry.id ? "" : ` (${where})`;
      const extra = [
        entry.containedIn === undefined ? undefined : `commits are in ${entry.containedIn}`,
        entry.worktreeStays === undefined ? undefined : `worktree stays: ${entry.worktreeStays}`,
      ].filter((part) => part !== undefined);
      const detail = extra.length === 0 ? "" : ` (${extra.join("; ")})`;
      return `  - ${entry.kind} ${entry.id}${suffix}: ${entry.reason}${detail}`;
    }),
  ];
}

/** `tandem fix --verbose`: every resource with its full id, path, and reason. */
export function renderFixReportVerbose(report: ReconcileReport): string {
  const dryRun = report.mode === "dry-run";
  const lines = [
    dryRun
      ? `Tandem checked ${report.home} and changed nothing yet.`
      : `Tandem cleaned up ${report.home}.`,
    ...verboseSection(dryRun ? "Would clean" : "Cleaned", report.cleaned),
    ...verboseSection("Retained", report.retained),
    ...verboseSection("Quarantined", report.quarantined),
    ...verboseSection("Failed", report.failed),
    ...verboseSection("Can also free", report.freeable),
  ];
  if (lines.length === 1) return `Tandem checked ${report.home}; nothing needs fixing.\n`;
  return `${lines.join("\n")}\n`;
}

/**
 * One line for re-nesting task workspaces under their coordinators, plus one per warning. Tandem
 * applies it without asking, since it only reorders its own workspaces, so the line says it is done.
 */
export function renderRenest(renest: RenestReport, details: FixDetails): string {
  const lines: string[] = [];
  if (renest.moved > 0) {
    const byRepo = new Map<string, Set<string>>();
    for (const move of renest.planned) {
      const titles = byRepo.get(move.repoPath) ?? new Set<string>();
      titles.add(details.tasks.get(move.taskId)?.title ?? "task");
      byRepo.set(move.repoPath, titles);
    }
    const what = [...byRepo.entries()]
      .map(
        ([repo, titles]) =>
          `${[...titles].join(", ")} workers under ${basename(repo)}'s coordinator`,
      )
      .join("; ");
    lines.push(`Re-nested (${renest.moved}) · moved ${what}`);
  }
  for (const warning of renest.warnings) lines.push(`Re-nest skipped: ${warning}`);
  // A label is never proof of ownership, so a workspace no record names is reported, not closed.
  for (const leftover of renest.leftovers) {
    const text = leftover.label.replace(/^└\s*/u, "");
    const name = TICKET_KEY.exec(text)?.[0] ?? (text.length > 32 ? `${text.slice(0, 31)}…` : text);
    lines.push(
      `Leftover workspace · ${name} · ${leftover.workspaceId}   kept: no task owns it any more; close it in Herdr if it is done`,
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
