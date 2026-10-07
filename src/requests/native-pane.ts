import { EndpointBusyError } from "../adapters/primitives.ts";
import { nativeBriefFile } from "../board/native-views.ts";
import type { RequestBriefRecord, RequestReviewPane } from "../contracts.ts";
import { type CoordinatorRecord, canonicalPath } from "../coordinator/record.ts";
import { findRecordedOwner } from "../coordinator/recorded-owner.ts";
import { publishViews, viewDetailPath } from "../native/store.ts";
import type { ViewsCapability } from "../terminal-backend/contract.ts";
import { briefView } from "./native-view.ts";
import type { RequestReviewPaneDependencies } from "./review-pane.ts";
import { createRequestBriefStore } from "./store.ts";

async function coordinatorForBrief(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<CoordinatorRecord> {
  const owner = await findRecordedOwner(deps.home, {
    by: "project",
    sessionId: deps.sessionId,
    path: await canonicalPath(record.repoPath, "brief repository"),
    terminal: deps.terminal.name,
    ...(deps.coordinatorPaneId === undefined ? {} : { paneId: deps.coordinatorPaneId }),
  });
  if (owner.status !== "owned")
    throw new Error("Native brief requires exactly one recorded Tern coordinator");
  return owner.record;
}

/** Native hosting owns exact-id proof, idempotent reuse and its durable unknown-outcome fence. */
export async function projectNativeBriefPane(
  deps: RequestReviewPaneDependencies,
  views: ViewsCapability,
  record: RequestBriefRecord,
): Promise<RequestReviewPane> {
  if (record.reviewPane?.status === "quarantined") return record.reviewPane;
  if (
    record.reviewPane !== undefined &&
    record.reviewPane.status !== "closed" &&
    record.reviewPane.endpoint.terminal !== deps.terminal.name
  ) {
    return {
      ...record.reviewPane,
      status: "quarantined",
      observedAt: deps.clock(),
      reason: "Brief projection belongs to another terminal",
    };
  }
  const owner = await coordinatorForBrief(deps, record);
  const renderedPath = viewDetailPath(deps.home, owner.repoPath, nativeBriefFile(record.id));
  const published = await publishViews(deps.home, owner.repoPath, async () => {
    const fresh = await createRequestBriefStore({
      home: deps.home,
      clock: deps.clock,
      idFactory: () => record.id,
    }).read(record.id);
    if (fresh === undefined || fresh.repoPath !== record.repoPath)
      throw new Error("Native brief no longer belongs to this repository");
    return { brief: briefView(fresh) };
  });
  const opened = await views.open({
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
    renderedRevision: published.brief.revision,
    renderedPath,
    observedAt: deps.clock(),
  };
}

/** Keep the approval or delivered feedback standing even when retirement is uncertain. */
export async function closeNativeBriefPane(
  deps: RequestReviewPaneDependencies,
  views: ViewsCapability,
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
  if (pane.endpoint.terminal !== deps.terminal.name)
    return settled(
      "quarantined",
      `Brief pane belongs to ${pane.endpoint.terminal}; kept open because the active terminal is ${deps.terminal.name}`,
    );
  try {
    const owner = await coordinatorForBrief(deps, record);
    const closed = await views.close({
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
