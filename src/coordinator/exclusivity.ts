import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import { findRunningCoordinator } from "./ownership.ts";
import { canonicalHome, canonicalPath, ownershipFailure, sessionText } from "./record.ts";
import {
  type DiscoveredCoordinatorRecord,
  discoverCoordinatorRecords,
  type UnreadableCoordinatorRecord,
} from "./registry.ts";
import {
  applyCoordinatorReplacement,
  type CoordinatorResourceOutcome,
  decideCoordinatorReplacement,
  observeCoordinatorCheckout,
  quarantineCoordinatorLease,
} from "./resources.ts";
import { type CoordinatorWorkspaceRetirement, retireCoordinatorWorkspace } from "./workspace.ts";

/** Environment setting that opts one launch out of the one-coordinator-per-repository rule. */
export const PARALLEL_COORDINATORS_VARIABLE = "TANDEM_ALLOW_PARALLEL_COORDINATORS";

/** Whether the user explicitly asked for parallel coordinators; off unless set to "1" or "true". */
export function parallelCoordinatorsAllowed(source: TandemEnvironmentSource): boolean {
  const value = source[PARALLEL_COORDINATORS_VARIABLE];
  return value === "1" || value === "true";
}

/** One Tandem home and one canonical repository inside it, both already resolved. */
type CanonicalRepositoryLocation = Readonly<{
  readonly home: string;
  readonly repoPath: string;
}>;

/** Whether another session's recorded coordinator still proves it is running. */
export type SessionCoordinatorLiveness =
  | Readonly<{ readonly status: "live" }>
  | Readonly<{ readonly status: "stopped" }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;

/** One other session's record for this repository, as it was observed. */
export type ObservedSessionCoordinator = Readonly<{
  readonly found: DiscoveredCoordinatorRecord;
  readonly liveness: SessionCoordinatorLiveness;
}>;

/** Everything the repository claim is allowed to look at. */
export type RepositoryCoordinatorObservation = Readonly<{
  readonly repoPath: string;
  readonly sessionId: string;
  /** Records stored under a session directory that is not the one their endpoint names. */
  readonly misplaced: readonly DiscoveredCoordinatorRecord[];
  readonly unreadable: readonly UnreadableCoordinatorRecord[];
  readonly otherSessions: readonly ObservedSessionCoordinator[];
}>;

/** Whether this launch may claim the repository, and what it must settle first. */
export type RepositoryCoordinatorClaim =
  | Readonly<{ readonly kind: "allocate"; readonly reason: string }>
  | Readonly<{
      readonly kind: "reconcile";
      readonly reason: string;
      readonly stale: readonly DiscoveredCoordinatorRecord[];
    }>
  | Readonly<{
      readonly kind: "refuse";
      readonly reason: string;
      /** Records whose ownership could not be proved, to be quarantined before refusing. */
      readonly quarantine: readonly DiscoveredCoordinatorRecord[];
    }>;

/** What a launch did with another session's coordinator record for the same repository. */
export type CoordinatorSessionReconciliation = Readonly<{
  readonly sessionId: string;
  readonly recordPath: string;
  readonly workspace: CoordinatorWorkspaceRetirement;
  readonly resources: CoordinatorResourceOutcome;
}>;

export type RepositoryCoordinatorClaimInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
  /** Read only when another session's lease must be judged, so ordinary launches pay nothing. */
  readonly requestedSourceHead: () => Promise<string>;
  readonly replacementLeaseHolder: (sourceHead: string) => string;
  readonly clock: () => string;
  readonly newId: () => string;
}>;

const ESCAPE_HATCH_GUIDANCE = `Set ${PARALLEL_COORDINATORS_VARIABLE}=1 to allow parallel coordinators for one repository.`;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides whether this launch owns the repository's single coordinator.
 *
 * A coordinator another session still runs is never stopped or stolen: the launch refuses and
 * names the session holding it. Records Tandem cannot place or read refuse too, so a duplicate
 * coordinator is never created on a guess. Only records that prove stopped are reconciled.
 */
export function decideRepositoryCoordinatorClaim(
  observation: RepositoryCoordinatorObservation,
): RepositoryCoordinatorClaim {
  const repoPath = JSON.stringify(observation.repoPath);
  if (observation.unreadable.length > 0) {
    const paths = observation.unreadable
      .map((entry) => `${entry.path} (${entry.reason})`)
      .join("; ");
    return {
      kind: "refuse",
      reason: `Tandem cannot prove which coordinator owns ${repoPath} because a stored coordinator record could not be read: ${paths}. Run tandem fix to list what Tandem found. ${ESCAPE_HATCH_GUIDANCE}`,
      quarantine: [],
    };
  }
  if (observation.misplaced.length > 0) {
    const paths = observation.misplaced
      .map((entry) => `${entry.path} names Herdr session ${JSON.stringify(entry.sessionId)}`)
      .join("; ");
    return {
      kind: "refuse",
      reason: `Tandem refuses to launch a coordinator for ${repoPath} because a stored coordinator record sits under a session directory it does not belong to: ${paths}. ${ESCAPE_HATCH_GUIDANCE}`,
      quarantine: observation.misplaced,
    };
  }
  const ambiguous = observation.otherSessions.flatMap((candidate) =>
    candidate.liveness.status === "ambiguous"
      ? [{ found: candidate.found, detail: candidate.liveness.detail }]
      : [],
  );
  const firstAmbiguous = ambiguous[0];
  if (firstAmbiguous !== undefined) {
    return {
      kind: "refuse",
      reason: `Tandem refuses to launch a second coordinator for ${repoPath} because the coordinator recorded in Herdr session ${JSON.stringify(
        firstAmbiguous.found.sessionId,
      )} could not be proved running or stopped: ${firstAmbiguous.detail}. ${ESCAPE_HATCH_GUIDANCE}`,
      quarantine: ambiguous.map((candidate) => candidate.found),
    };
  }
  const live = observation.otherSessions.find((candidate) => candidate.liveness.status === "live");
  if (live !== undefined) {
    return {
      kind: "refuse",
      reason: `Tandem already runs a coordinator for ${repoPath} in Herdr session ${JSON.stringify(
        live.found.sessionId,
      )} (pane ${JSON.stringify(live.found.record.endpoint.paneId)}). Reconnect there, or stop that coordinator and launch again; Tandem will not start a second one or close a coordinator it does not own. ${ESCAPE_HATCH_GUIDANCE}`,
      quarantine: [],
    };
  }
  const stale = observation.otherSessions.map((candidate) => candidate.found);
  if (stale.length === 0) {
    return {
      kind: "allocate",
      reason: `no other Tandem session records a coordinator for ${repoPath}`,
    };
  }
  return {
    kind: "reconcile",
    reason: `${stale.length} stopped coordinator record${stale.length === 1 ? "" : "s"} from ${
      stale.length === 1 ? "another Tandem session" : "other Tandem sessions"
    } must be settled before ${observation.sessionId} launches`,
    stale,
  };
}

async function observeSessionCoordinator(
  run: CommandRunner,
  location: CanonicalRepositoryLocation,
  found: DiscoveredCoordinatorRecord,
): Promise<ObservedSessionCoordinator> {
  try {
    const running = await findRunningCoordinator(run, {
      home: location.home,
      sessionId: found.sessionId,
      repoPath: location.repoPath,
    });
    return { found, liveness: running === undefined ? { status: "stopped" } : { status: "live" } };
  } catch (error) {
    return { found, liveness: { status: "ambiguous", detail: describeFailure(error) } };
  }
}

/**
 * Settles one stopped coordinator record from another session through the same retire, decide, and
 * apply path a same-session replacement uses, under that session's own launch lock.
 */
async function reconcileSessionCoordinator(
  input: RepositoryCoordinatorClaimInput,
  location: CanonicalRepositoryLocation,
  found: DiscoveredCoordinatorRecord,
): Promise<CoordinatorSessionReconciliation> {
  const sourceHead = await input.requestedSourceHead();
  return withCoordinatorLaunchLock(location.home, found.sessionId, async () => {
    const workspace = await retireCoordinatorWorkspace(input.run, location.home, found.record);
    const decision = decideCoordinatorReplacement({
      previous: found.record,
      paneRetirement: workspace,
      checkout: await observeCoordinatorCheckout(input.run, found.record.worktree.path),
      requestedSourceHead: sourceHead,
      replacementLeaseHolder: input.replacementLeaseHolder(sourceHead),
    });
    if (decision.kind === "reuse") {
      throw ownershipFailure(
        `coordinator record ${found.path} from Herdr session ${JSON.stringify(found.sessionId)} claims this launch's own lease holder`,
      );
    }
    const resources = await applyCoordinatorReplacement({
      run: input.run,
      home: location.home,
      sessionId: found.sessionId,
      repoPath: location.repoPath,
      clock: input.clock,
      newId: input.newId,
      decision,
    });
    return { sessionId: found.sessionId, recordPath: found.path, workspace, resources };
  });
}

/**
 * Writes a durable note for every record the refusal could not place, then describes the refusal.
 * Nothing is released or closed: a refusal leaves every resource exactly where it was.
 */
async function repositoryClaimRefusal(
  input: RepositoryCoordinatorClaimInput,
  location: CanonicalRepositoryLocation,
  claim: Extract<RepositoryCoordinatorClaim, { kind: "refuse" }>,
): Promise<Error> {
  const quarantinePaths: string[] = [];
  for (const found of claim.quarantine) {
    const outcome = await quarantineCoordinatorLease({
      home: location.home,
      sessionId: found.sessionId,
      repoPath: location.repoPath,
      stage: "exclusivity",
      reason: claim.reason,
      lease: found.record.worktree,
      endpoint: found.record.endpoint,
      clock: input.clock,
      newId: input.newId,
    });
    if (outcome.quarantinePath !== undefined) quarantinePaths.push(outcome.quarantinePath);
  }
  return new Error(
    quarantinePaths.length === 0
      ? claim.reason
      : `${claim.reason} Quarantine record${quarantinePaths.length === 1 ? "" : "s"}: ${quarantinePaths.join(", ")}.`,
  );
}

/**
 * Claims one canonical repository's single coordinator for the launching session.
 *
 * Callers hold the repository lock, so the records discovered here cannot change underneath the
 * claim. Records belonging to the launching session are left to the ordinary launch path; this
 * only settles what other sessions recorded.
 */
export async function claimRepositoryCoordinator(
  input: RepositoryCoordinatorClaimInput,
): Promise<readonly CoordinatorSessionReconciliation[]> {
  const sessionId = sessionText(input.sessionId);
  const location: CanonicalRepositoryLocation = {
    home: await canonicalHome(input.home),
    repoPath: await canonicalPath(input.repoPath, "repoPath"),
  };
  const discovery = await discoverCoordinatorRecords(location);
  const misplaced = discovery.records.filter((found) => found.placement === "foreign-directory");
  const otherSessionRecords = discovery.records.filter(
    (found) => found.placement === "session-directory" && found.sessionId !== sessionId,
  );
  const otherSessions: ObservedSessionCoordinator[] = [];
  for (const found of otherSessionRecords) {
    otherSessions.push(await observeSessionCoordinator(input.run, location, found));
  }
  const claim = decideRepositoryCoordinatorClaim({
    repoPath: location.repoPath,
    sessionId,
    misplaced,
    unreadable: discovery.unreadable,
    otherSessions,
  });
  if (claim.kind === "refuse") throw await repositoryClaimRefusal(input, location, claim);
  if (claim.kind === "allocate") return [];
  const reconciliations: CoordinatorSessionReconciliation[] = [];
  for (const found of claim.stale) {
    reconciliations.push(await reconcileSessionCoordinator(input, location, found));
  }
  return reconciliations;
}
