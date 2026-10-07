import { z } from "zod";
import { AdapterError, EndpointOwnershipError } from "../../adapters/primitives.ts";
import { nativeBriefFile, nativePrFile, nativeTaskFile } from "../../board/native-views.ts";
import type { Endpoint } from "../../contracts.ts";
import {
  blockArgs,
  type Placement,
  QUICK_TASK_FILE,
  setupFile,
  type ViewKind,
} from "../../native/contract.ts";
import {
  type Published,
  readPublished,
  viewDetailPath,
  viewIndexPath,
} from "../../native/store.ts";
import type { ViewsCapability } from "../contract.ts";
import { ternEndpoint } from "../identity.ts";
import type { TernCli } from "./cli.ts";
import { exactView, type OpenResult, openView, withSettledOpens } from "./host.ts";
import { blocks, TernOutcomeUnknownError, TernQuarantinedError } from "./protocol.ts";

class BrowserOpenUnconfirmedError extends AdapterError {
  constructor(cause: unknown) {
    super(
      "Tern did not confirm the PR opened in its browser. Tandem did not retry; open it again if it is missing.",
      "tern browser",
      cause,
    );
    this.name = "BrowserOpenUnconfirmedError";
  }
}
const Clients = z.object({ clients: z.array(z.object({ kind: z.string() })) });
export type ViewHostingInput = Parameters<ViewsCapability["open"]>[0];
/** The project of the one recorded coordinator in this exact pane, tab and worktree. */
export async function projectForView(
  home: string,
  coordinator: Endpoint,
  cwd: string,
): Promise<string> {
  const { canonicalPath } = await import("../../coordinator/record.ts");
  const { findRecordedOwner } = await import("../../coordinator/recorded-owner.ts");
  const owner = await findRecordedOwner(home, {
    by: "pane",
    pane: { ...coordinator, terminal: "tern" },
    // Records keep the worktree's real path; a harness may report it through a symlink like /tmp.
    cwd: await canonicalPath(cwd, "cwd"),
  });
  if (owner.status !== "owned")
    throw new Error("Native view requires exactly one recorded coordinator");
  return owner.record.repoPath;
}

export function detailForView(
  shown: Published | undefined,
  view: ViewHostingInput["view"],
): string | undefined {
  if (view.kind === "task")
    return shown?.tasks.includes(view.taskId) ? nativeTaskFile(view.taskId) : undefined;
  if (view.kind === "pr") {
    const pr = shown?.pullRequests.find((entry) =>
      "taskId" in view
        ? entry.taskId === view.taskId
        : entry.repo === view.repo && entry.number === view.number,
    );
    return pr === undefined ? undefined : nativePrFile(pr.repo, pr.number);
  }
  return undefined;
}

/**
 * The detail file a view's block reads, or undefined for a root view. A new draft can open before
 * the coordinator's background index publication, so a brief or setup needs no published entry.
 */
async function detailFile(
  home: string,
  project: string,
  view: Exclude<ViewHostingInput["view"], { kind: "browser" }>,
): Promise<string | undefined> {
  if (view.kind === "brief") return nativeBriefFile(view.requestId);
  if (view.kind === "setup") return setupFile(view.mode);
  if (view.kind === "quick-task") return QUICK_TASK_FILE;
  return detailForView(await readPublished(home, project), view);
}

/** Where a view's block is placed; `isView` proves a block only where an open puts it. */
function placementFor(view: Exclude<ViewHostingInput["view"], { kind: "browser" }>): Placement {
  if (view.kind === "task") return "task";
  return view.kind === "brief" ||
    view.kind === "pr" ||
    view.kind === "prs" ||
    view.kind === "task-picker" ||
    view.kind === "quick-task" ||
    (view.kind === "setup" && view.mode === "setup")
    ? "split"
    : "window";
}

/** File routes are the sole CLI-to-block launch port. An uncertain invocation is never repeated. */
export function ternViewHost(commands: TernCli) {
  const scoped = async (input: ViewHostingInput, allowMissingOrigin = false) => {
    // Luau's native layout API uses numbers. Reject ids it cannot represent exactly.
    for (const id of [
      input.coordinator.paneId,
      input.coordinator.tabId,
      input.coordinator.terminalSessionId,
      input.origin?.paneId ?? input.coordinator.paneId,
    ]) {
      if (id === undefined || !/^[1-9][0-9]*$/u.test(id) || !Number.isSafeInteger(Number(id)))
        throw new AdapterError(
          "Native layout requires exactly representable Tern ids",
          "tern open",
        );
    }
    const key = input.origin?.windowId;

    // A supplied key is scoped independently and must contain both exact panes.
    const cmd = commands.scope({
      ...(key === undefined ? {} : { windowKey: key }),
      home: input.home,
    });
    if (key === undefined) {
      const clients = await cmd.read(input.cwd, ["inspect"], Clients);
      if (clients.clients.filter((client) => client.kind === "window").length !== 1)
        throw new AdapterError(
          "Native view needs a unique owning Tern window; supply --window when several are open",
          "tern open",
        );
    }
    await cmd.exactPane({ endpoint: input.coordinator, cwd: input.cwd });
    const originId = input.origin?.paneId ?? input.coordinator.paneId;
    const listing = await cmd.ls(input.cwd);
    const origin = blocks(listing).find((entry) => entry.block.id === originId);
    if (origin === undefined && allowMissingOrigin && listing.detached.length === 0) return cmd;
    if (origin === undefined || origin.session.id !== input.coordinator.terminalSessionId)
      throw new EndpointOwnershipError(
        input.coordinator,
        "origin pane is outside the recorded project session",
      );
    return cmd;
  };
  const open = async (
    input: ViewHostingInput,
    project: string,
    kind: ViewKind,
    placement: Placement,
    path: string,
  ): Promise<OpenResult> =>
    openView(
      await scoped(input, placement === "return"),
      {
        coordinator: input.coordinator,
        cwd: input.cwd,
        home: input.home,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        returnToConversation: placement === "return" && input.view.kind === "orchestrator",
      },
      project,
      kind,
      placement,
      path,
    );
  const close = async (input: Parameters<ViewsCapability["close"]>[0], project: string) => {
    if (input.origin.paneId === input.coordinator.paneId)
      throw new EndpointOwnershipError(
        input.coordinator,
        "cannot retire the conversation as a brief",
      );
    const cmd = await scoped(input, true);
    const args = blockArgs(
      viewDetailPath(input.home, project, nativeBriefFile(input.view.requestId)),
      {
        coordinator: input.coordinator.paneId,
        cwd: input.cwd,
        home: input.home,
        index: viewIndexPath(input.home, project),
        ...(input.origin.windowId === undefined ? {} : { window: input.origin.windowId }),
      },
    );
    // The listed tab places the exact pane; an absent pane still passes the quarantine read.
    const entry = blocks(await cmd.ls(input.cwd)).find(
      (each) => each.block.id === input.origin.paneId,
    );
    await cmd.mutate({
      verb: "close",
      endpoint: ternEndpoint({
        ...input.coordinator,
        paneId: input.origin.paneId,
        ...(entry === undefined ? {} : { workspaceId: entry.tab.id, tabId: entry.tab.id }),
      }),
      cwd: input.cwd,
      view: { program: "tandem.brief", args },
      owner: ternEndpoint(input.coordinator),
    });
    return { closed: true, warnings: [] };
  };
  const toggleBoard = async (input: ViewHostingInput, project: string): Promise<boolean> => {
    const cmd = await scoped(input);
    const source = blocks(await cmd.ls(input.cwd)).find(
      (entry) => entry.block.id === (input.origin?.paneId ?? input.coordinator.paneId),
    );
    if (source?.block.program !== "tandem.board") return false;
    await open(input, project, "panel", "return", viewIndexPath(input.home, project));
    return true;
  };
  /**
   * The origin pane is this coordinator's exact block of the view, as Tern lists it: program
   * `tandem.<kind>`, the launch arguments Tandem gives that view, its session and its placement.
   */
  const proveView = async (
    input: Parameters<ViewsCapability["isView"]>[0],
    project: string,
  ): Promise<boolean> => {
    if (input.origin.paneId === input.coordinator.paneId) return false;
    const detail = await detailFile(input.home, project, input.view);
    if (detail === undefined) return false;
    const cmd = await scoped(input);
    const args = blockArgs(viewDetailPath(input.home, project, detail), {
      coordinator: input.coordinator.paneId,
      cwd: input.cwd,
      home: input.home,
      index: viewIndexPath(input.home, project),
      ...(input.origin.windowId === undefined ? {} : { window: input.origin.windowId }),
    });
    let exact: Awaited<ReturnType<typeof exactView>>;
    try {
      exact = await exactView(
        cmd,
        input.cwd,
        input.coordinator,
        input.view.kind,
        placementFor(input.view),
        args,
      );
    } catch (cause) {
      if (!(cause instanceof TernOutcomeUnknownError)) throw cause;
      // A proof only reads, so ambiguity quarantines nothing; it just proves nothing.
      throw new AdapterError(
        "Tern lists this view ambiguously: detached, duplicated or outside its placement",
        "tern ls",
        cause,
      );
    }
    return exact?.block.id === input.origin.paneId;
  };
  return {
    open,
    scoped,
    proveView,
    isView: async (input: Parameters<ViewsCapability["isView"]>[0]) =>
      proveView(input, await projectForView(input.home, input.coordinator, input.cwd)),
    close,
    toggleBoard,
    closeView: async (input: Parameters<ViewsCapability["close"]>[0]) =>
      close(input, await projectForView(input.home, input.coordinator, input.cwd)),
    openView: async (input: ViewHostingInput) => {
      const project = await projectForView(input.home, input.coordinator, input.cwd);
      if (input.view.kind === "browser") {
        const url = new URL(input.view.url);
        if (url.protocol !== "https:") throw new Error("PR links require an HTTPS URL");
        const cmd = await scoped(input);
        await withSettledOpens(
          cmd,
          input.coordinator,
          project,
          { cwd: input.cwd, home: input.home, index: viewIndexPath(input.home, project) },
          async () => {
            // Nothing can later prove or disprove a browser opening, and it is never
            // re-invoked, so an unconfirmed one is reported once and pauses nothing.
            try {
              await cmd.mutate({
                verb: "browser",
                endpoint: ternEndpoint(input.coordinator),
                cwd: input.cwd,
                url,
              });
            } catch (cause) {
              if (
                cause instanceof TernOutcomeUnknownError &&
                !(cause instanceof TernQuarantinedError)
              )
                throw new BrowserOpenUnconfirmedError(cause);
              throw cause;
            }
          },
        );
        return { opened: true, warnings: [] };
      }
      if (input.view.kind === "board" && (await toggleBoard(input, project)))
        return { opened: true, warnings: [] };
      if (input.view.kind === "orchestrator" || input.view.kind === "inbox") {
        const returned = await open(
          input,
          project,
          "panel",
          input.view.kind === "inbox" ? "inbox" : "return",
          viewIndexPath(input.home, project),
        );
        return { opened: true, warnings: returned.warnings ?? [] };
      }
      const detail = await detailFile(input.home, project, input.view);
      if (["task", "brief", "pr"].includes(input.view.kind) && detail === undefined)
        throw new Error(`Native ${input.view.kind} detail is not ready`);
      const path =
        detail === undefined
          ? viewIndexPath(input.home, project)
          : viewDetailPath(input.home, project, detail);
      const opened = await open(input, project, input.view.kind, placementFor(input.view), path);
      if (input.view.kind === "brief" && opened.endpoint === undefined)
        throw new TernOutcomeUnknownError("tern open", "native brief endpoint was not confirmed");
      return {
        opened: true,
        warnings: [],
        ...(input.view.kind === "brief" && opened.endpoint !== undefined
          ? { endpoint: opened.endpoint }
          : {}),
      };
    },
  };
}
