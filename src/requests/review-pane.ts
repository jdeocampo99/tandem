import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  closeEndpoint,
  createTaskEndpoint,
  type HerdrPaneInspection,
  inspectEndpoint,
  sendCommand,
  splitBesidePane,
} from "../adapters/herdr.ts";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type {
  Clock,
  CommandRunner,
  Endpoint,
  RequestBriefRecord,
  RequestReviewPane,
} from "../contracts.ts";
import { ensurePrivateDirectoryTree } from "../coordinator/lock.ts";
import {
  isMissingEndpointError,
  readSessionSnapshot,
  snapshotPaneForEndpoint,
} from "../coordinator/ownership.ts";
import { canonicalPath } from "../coordinator/record.ts";
import { renderRequestBriefMarkdown } from "./markdown.ts";

/** Directory under the Tandem home holding the rendered read-only brief projections. */
export const REQUEST_BRIEF_DIRECTORY = "request-briefs";

export type RequestReviewPaneDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId: string | undefined;
  /**
   * The Herdr pane the coordinator itself runs in, when known. The review pane opens as a split
   * beside it so the user sees the brief in the tab they are already looking at. The coordinator
   * pane is only ever the split anchor: it is never written to, rendered into, or closed.
   */
  readonly coordinatorPaneId: string | undefined;
  readonly clock: Clock;
}>;

/**
 * Styles the Markdown with glow when it is installed, and shows it as plain text otherwise. Glow
 * wraps at the pane's own width: a `width` in the user's glow config would otherwise win, and a
 * split pane narrower than it re-wraps every line mid-word.
 * ponytail: looks glow up on Tandem's PATH, not the pane's; bundle a renderer if glow proves rare.
 */
export function briefViewerCommand(renderedPath: string): readonly string[] {
  const glow = Bun.which("glow");
  if (glow === null) return ["cat", "--", renderedPath];
  return ["sh", "-c", 'exec "$1" -w "$(tput cols)" -- "$2"', "sh", glow, renderedPath];
}

export function requestBriefMarkdownPath(home: string, requestId: string): string {
  return join(home, REQUEST_BRIEF_DIRECTORY, `${requestId}.md`);
}

export function requestBriefWorkspaceLabel(repoPath: string): string {
  return `Tandem request brief · ${basename(repoPath)}`;
}

/**
 * Brings the owned review pane up to date with the current draft: refreshes the pane this request
 * already owns, and opens a new one whenever the recorded pane is gone. A pane whose exact Herdr
 * identity no longer proves ownership is never written to; it is reported instead, and a fresh
 * owned pane takes over the projection so the user still sees the current revision.
 */
export async function projectRequestBriefPane(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<RequestReviewPane> {
  const renderedPath = await writeRenderedBrief(deps.home, record);
  const existing = record.reviewPane;
  if (existing !== undefined && existing.status !== "closed") {
    const ownership = await proveOwnedPane(deps, existing.endpoint, record.repoPath);
    if (ownership.kind === "owned") {
      return renderInto(deps, record, existing.endpoint, renderedPath);
    }
    if (ownership.kind !== "missing") {
      return {
        status: ownership.kind === "busy" ? "retained" : "quarantined",
        endpoint: existing.endpoint,
        renderedRevision: existing.renderedRevision,
        renderedPath,
        observedAt: deps.clock(),
        reason: ownership.reason,
      };
    }
  }
  const endpoint = await openReviewPane(deps, record);
  return renderInto(deps, record, endpoint, renderedPath);
}

/**
 * Closes the one temporary pane this request owns, after its exact identity and stopped state are
 * proven again. Anything else, including a busy pane or a failed close, leaves every pane open and
 * is reported on the durable record; the brief and its approval are never affected either way.
 */
export async function closeRequestBriefPane(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<RequestReviewPane | undefined> {
  const pane = record.reviewPane;
  if (pane === undefined || pane.status === "closed") return undefined;
  const settled = (status: RequestReviewPane["status"], reason?: string): RequestReviewPane => ({
    ...pane,
    status,
    observedAt: deps.clock(),
    ...(reason === undefined ? {} : { reason }),
  });
  const ownership = await proveOwnedPane(deps, pane.endpoint, record.repoPath);
  if (ownership.kind === "missing") return settled("closed", "pane was already gone");
  if (ownership.kind === "busy") return settled("retained", ownership.reason);
  if (ownership.kind === "unowned") return settled("quarantined", ownership.reason);
  try {
    await closeEndpoint(deps.run, { endpoint: pane.endpoint, cwd: record.repoPath });
  } catch (error) {
    if (error instanceof EndpointBusyError) return settled("retained", error.message);
    return settled("quarantined", `review pane could not be closed: ${describeFailure(error)}`);
  }
  return settled("closed");
}

/** What a recorded pane still proves about itself before anything is written to or closed. */
type PaneOwnership =
  | Readonly<{ readonly kind: "owned" }>
  | Readonly<{ readonly kind: "missing" }>
  | Readonly<{ readonly kind: "busy"; readonly reason: string }>
  | Readonly<{ readonly kind: "unowned"; readonly reason: string }>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeRenderedBrief(home: string, record: RequestBriefRecord): Promise<string> {
  const path = requestBriefMarkdownPath(home, record.id);
  await ensurePrivateDirectoryTree(dirname(path), "request brief directory");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, renderRequestBriefMarkdown(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return path;
}

/**
 * Confirms the recorded pane is still the same pane, in the same workspace and tab, sitting in the
 * directory it was opened in, with nothing running in it. A pane that appears more than once, has
 * moved, or has been taken over is `unowned`, which every caller treats as do-not-touch. The
 * review pane shares the coordinator's tab, so a record naming the coordinator's own pane is
 * `unowned` before Herdr is even asked: that pane is never the brief's to write to or close.
 */
async function proveOwnedPane(
  deps: RequestReviewPaneDependencies,
  endpoint: Endpoint,
  repoPath: string,
): Promise<PaneOwnership> {
  const run = deps.run;
  if (endpoint.paneId === deps.coordinatorPaneId) {
    return {
      kind: "unowned",
      reason: `review pane record names the coordinator's own pane ${JSON.stringify(endpoint.paneId)}`,
    };
  }
  let inspection: HerdrPaneInspection;
  try {
    const panes = await readSessionSnapshot(run, endpoint.sessionId, repoPath, true);
    const pane = snapshotPaneForEndpoint(panes, endpoint, "request brief review");
    if (pane === undefined) return { kind: "missing" };
    inspection = await inspectEndpoint(run, { endpoint, cwd: repoPath });
  } catch (error) {
    if (isMissingEndpointError(error)) return { kind: "missing" };
    return { kind: "unowned", reason: describeFailure(error) };
  }
  if (inspection.activeWorker) {
    return {
      kind: "busy",
      reason: `review pane ${JSON.stringify(endpoint.paneId)} is running a foreground process`,
    };
  }
  const foregroundCwd = inspection.pane.foregroundCwd;
  if (foregroundCwd === undefined) {
    return {
      kind: "unowned",
      reason: `review pane ${JSON.stringify(endpoint.paneId)} reported no foreground working directory`,
    };
  }
  const canonicalForeground = await canonicalPath(foregroundCwd, "review pane cwd");
  const canonicalRepo = await canonicalPath(repoPath, "repoPath");
  if (canonicalForeground !== canonicalRepo) {
    return {
      kind: "unowned",
      reason: `review pane ${JSON.stringify(endpoint.paneId)} moved to ${JSON.stringify(canonicalForeground)}`,
    };
  }
  return { kind: "owned" };
}

/**
 * Opens the review pane as a split beside the coordinator's own pane, in the coordinator's
 * workspace and tab. When the coordinator's pane is unknown (no Herdr context), it falls back to a
 * separate "Tandem request brief" workspace placed after the parent workspace.
 */
async function openReviewPane(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
): Promise<Endpoint> {
  if (deps.coordinatorPaneId !== undefined) {
    const split = await splitBesidePane(deps.run, {
      sessionId: deps.sessionId,
      cwd: record.repoPath,
      anchorPaneId: deps.coordinatorPaneId,
      role: "coordinator",
      generation: 0,
    });
    return split.endpoint;
  }
  const created = await createTaskEndpoint(deps.run, {
    sessionId: deps.sessionId,
    cwd: record.repoPath,
    taskName: record.id,
    workspaceLabel: requestBriefWorkspaceLabel(record.repoPath),
    role: "coordinator",
    generation: 0,
    ...(deps.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: deps.parentWorkspaceId }),
  });
  return created.endpoint;
}

async function renderInto(
  deps: RequestReviewPaneDependencies,
  record: RequestBriefRecord,
  endpoint: Endpoint,
  renderedPath: string,
): Promise<RequestReviewPane> {
  const observedAt = deps.clock();
  try {
    await sendCommand(deps.run, {
      endpoint,
      cwd: record.repoPath,
      command: briefViewerCommand(renderedPath),
    });
  } catch (error) {
    return {
      status: "quarantined",
      endpoint,
      renderedRevision: record.draft.revision,
      renderedPath,
      observedAt,
      reason: `review pane could not render revision ${record.draft.revision}: ${describeFailure(error)}`,
    };
  }
  return {
    status: "open",
    endpoint,
    renderedRevision: record.draft.revision,
    renderedPath,
    observedAt,
  };
}
