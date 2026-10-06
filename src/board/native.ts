import { nativeCostLabel } from "../runtime/usage-display.ts";
import type { NativePanelRow, NativeTaskSummary } from "./panel.ts";
import { nativePanelView } from "./panel.ts";
import type { BoardSnapshot } from "./snapshot.ts";

export type NativeBoardCard = NativePanelRow &
  Readonly<{
    costLabel?: string;
    harnessGlyph?: string;
    harness?: string;
    branch?: string;
    costMicros?: number;
    unpricedSamples: number;
    stuck: boolean;
  }>;
export type NativeBoardView = Readonly<{
  viewOnly: true;
  returnLabel: string;
  lanes: readonly Readonly<{
    title: "Working" | "Needs you" | "In review" | "Ready to merge";
    count: number;
    cards: readonly NativeBoardCard[];
  }>[];
}>;

export function nativeBoardView(
  snapshot: BoardSnapshot,
  project: string,
  tasks: readonly NativeTaskSummary[],
  now: string,
): NativeBoardView {
  const panel = nativePanelView({ snapshot, project, now, tasks, bellCount: 0 });
  const rows = panel.sections
    .filter((section) => section.title !== "Recently done")
    .flatMap((section) => section.rows.map((row) => ({ row, section: section.title })));
  const cards = rows.map(({ row, section }) => {
    const task = tasks.find(
      (task) =>
        (row.target.kind === "task" && row.target.taskId === task.taskId) ||
        (row.target.kind === "pr" &&
          task.pullRequest?.repo === row.target.repo &&
          task.pullRequest?.number === row.target.number),
    );
    const lane =
      task?.stage === "blocked" &&
      (task.previousStage === "reviewing" || task.previousStage === "awaiting-fixes")
        ? "In review"
        : section === "Needs you"
          ? "Needs you"
          : section === "Ready"
            ? "Ready to merge"
            : task?.stage === "reviewing" || task?.stage === "validating"
              ? "In review"
              : "Working";
    const card: NativeBoardCard = {
      ...row,
      costLabel: nativeCostLabel(task?.costMicros, task?.unpricedSamples),
      harnessGlyph: task?.harness === "claude-code" ? "✻" : task?.harness === "omp" ? "ω" : "",
      ...(task?.harness === undefined ? {} : { harness: task.harness }),
      ...(task?.branch === undefined ? {} : { branch: task.branch }),
      ...(task?.costMicros === undefined ? {} : { costMicros: task.costMicros }),
      unpricedSamples: task?.unpricedSamples ?? 0,
      stuck: task?.stage === "blocked",
    };
    return { lane, card };
  });
  return {
    viewOnly: true,
    returnLabel: "← Orchestrator",
    lanes: (["Working", "Needs you", "In review", "Ready to merge"] as const).map((title) => ({
      title,
      count: cards.filter((card) => card.lane === title).length,
      cards: cards.filter((card) => card.lane === title).map((card) => card.card),
    })),
  };
}
