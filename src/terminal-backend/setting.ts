import type { TaskRecord, TerminalName } from "../contracts.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import type { TerminalAvailability } from "./contract.ts";

/** Only a confirmed signed-in account may be offered Tern. */
export function ternFallbackReason(availability: TerminalAvailability): string | undefined {
  switch (availability.status) {
    case "ready":
      return undefined;
    case "missing":
      return "Tern is not installed. Using Herdr.";
    case "signedOut":
      return "Sign in to Tern with your Stencil account first. Using Herdr.";
    case "unknown":
      return `${availability.reason.replace(/[\r\n]+/gu, " ")} Using Herdr.`;
  }
}

/** Switching is refused while any job or uncertain reservation could still own terminal work. */
export function assertTerminalSwitch(
  current: TerminalName,
  chosen: TerminalName,
  tasks: readonly TaskRecord[],
  state: RuntimeState,
): void {
  if (current === chosen) return;
  const running = tasks.find((task) =>
    ["queued", "scouting", "implementing", "validating", "reviewing", "awaiting-fixes"].includes(
      task.stage,
    ),
  );
  const owned = state.tasks.find(
    (task) =>
      task.jobs.some(activeRuntimeJob) ||
      unreleasedReservation(task.reservation) ||
      task.endpointLaunch !== undefined ||
      task.operation?.phase === "quarantined",
  );
  const drawing = state.presentations.find(
    (presentation) =>
      (presentation.job !== undefined && activeRuntimeJob(presentation.job)) ||
      unreleasedReservation(presentation.reservation) ||
      presentation.endpointLaunch !== undefined ||
      presentation.operation?.phase === "quarantined",
  );
  if (running !== undefined || owned !== undefined || drawing !== undefined) {
    const taskId = running?.id ?? owned?.taskId ?? drawing?.taskId;
    throw new Error(
      `Cannot switch from ${current} to ${chosen} while tasks are running or retain uncertain ownership${taskId === undefined ? "" : ` (${taskId})`}. Stop or finish them first.`,
    );
  }
}

export type TerminalChoiceResult = Readonly<{
  requested: TerminalName;
  terminal: TerminalName;
  reason?: string;
}>;
