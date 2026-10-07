import type { Endpoint, TerminalName } from "../contracts.ts";
import type { CoordinatorRecord } from "./record.ts";
import { listCoordinatorRecords } from "./registry.ts";

/** A coordinator pane as a terminal places it. A recorded endpoint satisfies it directly. */
export type CoordinatorPane = Pick<
  Endpoint,
  "terminal" | "sessionId" | "terminalSessionId" | "workspaceId" | "tabId" | "paneId" | "generation"
>;

/**
 * What a caller knows about the coordinator it needs. Each claim is matched exactly; a record
 * owns it only when it is the one record in the claim's session that matches.
 */
export type CoordinatorClaim =
  | Readonly<{
      by: "pane";
      pane: CoordinatorPane;
      /** The coordinator's worktree: the record's lease must name this exact path. */
      cwd: string;
    }>
  | Readonly<{
      by: "project";
      sessionId: string;
      /** Canonical path of the repository or of its coordinator worktree. */
      path: string;
      terminal: TerminalName | "any";
      /** When set, only the coordinator in this exact pane. */
      paneId?: string;
    }>;

/** The one record owning a claim, or why none does. Ambiguity never resolves to an owner. */
export type RecordedOwner =
  | Readonly<{ status: "owned"; record: CoordinatorRecord }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "ambiguous" }>;

function claimSession(claim: CoordinatorClaim): string {
  return claim.by === "pane" ? claim.pane.sessionId : claim.sessionId;
}

function matches(record: CoordinatorRecord, claim: CoordinatorClaim): boolean {
  const { endpoint } = record;
  if (endpoint.sessionId !== claimSession(claim)) return false;
  if (claim.by === "project")
    return (
      (claim.terminal === "any" || endpoint.terminal === claim.terminal) &&
      (record.repoPath === claim.path || record.worktree.path === claim.path) &&
      (claim.paneId === undefined || endpoint.paneId === claim.paneId)
    );
  const { pane } = claim;
  return (
    endpoint.terminal === pane.terminal &&
    endpoint.terminalSessionId === pane.terminalSessionId &&
    endpoint.workspaceId === pane.workspaceId &&
    endpoint.tabId === pane.tabId &&
    endpoint.paneId === pane.paneId &&
    endpoint.generation === pane.generation &&
    record.worktree.path === claim.cwd
  );
}

/** Decides ownership over records the caller already read. */
export function decideRecordedOwner(
  records: readonly CoordinatorRecord[],
  claim: CoordinatorClaim,
): RecordedOwner {
  const owners = records.filter((record) => matches(record, claim));
  const [owner] = owners;
  if (owner === undefined) return { status: "none" };
  return owners.length === 1 ? { status: "owned", record: owner } : { status: "ambiguous" };
}

/** Reads the claim's session registry and decides which recorded coordinator owns the claim. */
export async function findRecordedOwner(
  home: string,
  claim: CoordinatorClaim,
): Promise<RecordedOwner> {
  return decideRecordedOwner(await listCoordinatorRecords(home, claimSession(claim)), claim);
}
