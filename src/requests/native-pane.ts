import { EndpointBusyError } from "../adapters/primitives.ts";
import { writeNativeBriefDetail } from "../board/snapshot.ts";
import type { RequestBriefRecord, RequestReviewPane } from "../contracts.ts";
import { type CoordinatorRecord, canonicalPath } from "../coordinator/record.ts";
import { listCoordinatorRecords } from "../coordinator/registry.ts";
import { briefView } from "./native-view.ts";
import type { RequestReviewPaneDependencies } from "./review-pane.ts";

async function coordinatorForBrief(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<CoordinatorRecord> {
  const repo = await canonicalPath(record.repoPath, "brief repository");
  const matches = (await listCoordinatorRecords(deps.home, deps.sessionId)).filter(
    (owner) =>
      owner.endpoint.terminal === "tern" &&
      (owner.repoPath === repo || owner.worktree.path === repo) &&
      (deps.coordinatorPaneId === undefined || owner.endpoint.paneId === deps.coordinatorPaneId),
  );
  const owner = matches[0];
  if (matches.length !== 1 || owner === undefined)
    throw new Error("Native brief requires exactly one recorded Tern coordinator");
  return owner;
}

/** Native hosting owns exact-id proof, idempotent reuse and its durable unknown-outcome fence. */
export async function projectNativeBriefPane(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<RequestReviewPane> {
  if (record.reviewPane?.status === "quarantined") return record.reviewPane;
  if (
    record.reviewPane !== undefined &&
    record.reviewPane.status !== "closed" &&
    record.reviewPane.endpoint.terminal !== "tern"
  ) {
    return {
      ...record.reviewPane,
      status: "quarantined",
      observedAt: deps.clock(),
      reason: "Brief projection belongs to another terminal",
    };
  }
  const owner = await coordinatorForBrief(deps, record);
  const renderedPath = await writeNativeBriefDetail(deps.home, owner.repoPath, briefView(record));
  const opened = await deps.terminal.openView({
    coordinator: owner.endpoint,
    cwd: owner.worktree.path,
    home: deps.home,
    view: { kind: "brief", requestId: record.id },
    origin: { paneId: owner.endpoint.paneId, cwd: owner.worktree.path },
  });
  if (!opened.opened || opened.endpoint === undefined)
    throw new Error(opened.warnings.join("; ") || "Native brief opening was not confirmed");
  return {
    status: "open",
    endpoint: opened.endpoint,
    renderedRevision: record.draft.revision,
    renderedPath,
    observedAt: deps.clock(),
  };
}

/** Keep the approval or delivered feedback standing even when retirement is uncertain. */
export async function closeNativeBriefPane(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<RequestReviewPane | undefined> {
  const pane = record.reviewPane;
  if (pane === undefined || pane.status === "closed" || pane.status === "quarantined")
    return undefined;
  const settled = (status: RequestReviewPane["status"], reason?: string): RequestReviewPane => ({
    ...pane,
    status,
    observedAt: deps.clock(),
    ...(reason === undefined ? {} : { reason }),
  });
  try {
    const owner = await coordinatorForBrief(deps, record);
    const closed = await deps.terminal.closeView({
      coordinator: owner.endpoint,
      cwd: owner.worktree.path,
      home: deps.home,
      origin: { paneId: pane.endpoint.paneId },
      view: { kind: "brief", requestId: record.id },
    });
    return closed.closed
      ? settled("closed")
      : settled("retained", closed.warnings.join("; ") || "Native brief remains open");
  } catch (error) {
    return settled(
      error instanceof EndpointBusyError ? "retained" : "quarantined",
      `native brief could not be closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
