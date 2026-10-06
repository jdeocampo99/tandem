import { z } from "zod";
import {
  AdapterError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import { type NativeNavigationModel, readNativeBundle } from "../../board/native-file.ts";
import { nativeBriefFile } from "../../board/native-views.ts";
import { nativeDetailPath, nativeViewsPath } from "../../board/snapshot.ts";
import type { Endpoint } from "../../contracts.ts";
import { blockArgs, type Placement, type ViewKind } from "../../native/contract.ts";
import type { TerminalBackend } from "../contract.ts";
import { exactPane } from "./endpoints.ts";
import { type OpenResult, openView, withSettledOpens } from "./host.ts";
import {
  BlockAck,
  blocks,
  Id,
  Processes,
  type TernCommands,
  TernOutcomeUnknownError,
  ternCommands,
} from "./protocol.ts";

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
const BrowserOpened = z.object({ ok: z.object({ block: Id }) });
const Clients = z.object({ clients: z.array(z.object({ kind: z.string() })) });
export type ViewHostingInput = Parameters<TerminalBackend["openView"]>[0];
export async function projectForView(home: string, coordinator: Endpoint): Promise<string> {
  const { listCoordinatorRecords } = await import("../../coordinator/registry.ts");
  const records = (await listCoordinatorRecords(home, coordinator.sessionId)).filter(
    (record) =>
      record.endpoint.terminal === "tern" &&
      record.endpoint.paneId === coordinator.paneId &&
      record.endpoint.terminalSessionId === coordinator.terminalSessionId,
  );
  if (records.length !== 1 || records[0] === undefined)
    throw new Error("Native view requires exactly one recorded coordinator");
  return records[0].repoPath;
}

export function detailForView(
  bundle: NativeNavigationModel,
  view: ViewHostingInput["view"],
): string | undefined {
  if (view.kind === "task") return bundle.tasks[view.taskId]?.detailFile;
  if (view.kind === "brief") return bundle.briefs[view.requestId]?.detailFile;
  if (view.kind === "pr")
    return Object.values(bundle.pullRequests).find((pr) =>
      "taskId" in view
        ? pr.header.taskId === view.taskId
        : pr.header.repo === view.repo && pr.header.number === view.number,
    )?.detailFile;
  return undefined;
}

/** File routes are the sole CLI-to-block launch port. An uncertain invocation is never repeated. */
export function ternViewHost(
  commands: TernCommands,
  options: {
    wait: (ms: number) => Promise<void>;
    clock: () => number;
    /** Refuses an open while its coordinator pane is quarantined; opens record their own outcome. */
    guardOpen?: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
    guard: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  },
) {
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
    const base = commands.request(input.cwd, []);
    const cmd =
      key === undefined
        ? commands
        : ternCommands(commands.run, {
            binary: commands.binary,
            windowKey: key,
            ...(base.env === undefined ? {} : { environment: base.env }),
          });
    if (key === undefined) {
      const clients = await cmd.read(input.cwd, ["inspect"], Clients);
      if (clients.clients.filter((client) => client.kind === "window").length !== 1)
        throw new AdapterError(
          "Native view needs a unique owning Tern window; supply --window when several are open",
          "tern open",
        );
    }
    await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
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
  ): Promise<OpenResult> => {
    const cmd = await scoped(input, placement === "return");
    return (options.guardOpen ?? options.guard)(input.coordinator.paneId, () =>
      openView(
        cmd,
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
        options,
      ),
    );
  };
  const close = async (input: Parameters<TerminalBackend["closeView"]>[0], project: string) => {
    if (input.origin.paneId === input.coordinator.paneId)
      throw new EndpointOwnershipError(
        input.coordinator,
        "cannot retire the conversation as a brief",
      );
    const cmd = await scoped(input, true);
    return options.guard(input.coordinator.paneId, async () => {
      const args = blockArgs(
        nativeDetailPath(input.home, project, nativeBriefFile(input.view.requestId)),
        {
          coordinator: input.coordinator.paneId,
          cwd: input.cwd,
          home: input.home,
          index: nativeViewsPath(input.home, project),
          ...(input.origin.windowId === undefined ? {} : { window: input.origin.windowId }),
        },
      );
      const listing = await cmd.ls(input.cwd);
      const entry = blocks(listing).find((each) => each.block.id === input.origin.paneId);
      if (entry === undefined) {
        if (listing.detached.length > 0)
          throw new EndpointOwnershipError(
            input.coordinator,
            "detached panes make brief closure ambiguous",
          );
        return { closed: true, warnings: [] };
      }
      const endpoint: Endpoint = {
        ...input.coordinator,
        paneId: entry.block.id,
        workspaceId: entry.tab.id,
        tabId: entry.tab.id,
      };
      const proveIdentity = async () => {
        const current = await exactPane(cmd, { endpoint, cwd: input.cwd });
        if (
          current.block.program !== "tandem.brief" ||
          JSON.stringify(current.block.args) !== JSON.stringify(args)
        )
          throw new EndpointOwnershipError(
            endpoint,
            "origin is not this request's exact native brief",
          );
      };
      const prove = async () => {
        await proveIdentity();
        const process = await cmd.read(input.cwd, ["process", endpoint.paneId], Processes);
        if (
          process.pane !== endpoint.paneId ||
          process.child !== null ||
          process.foreground !== null ||
          process.group !== null
        )
          throw new EndpointBusyError(endpoint);
      };
      await prove();
      // Identity, arguments and idle state must still hold immediately before the effect.
      await prove();
      await proveIdentity();
      const ack = await cmd.mutate(input.cwd, ["close", endpoint.paneId], BlockAck);
      if (ack.block !== endpoint.paneId)
        throw new TernOutcomeUnknownError("brief close", "acknowledged another block");
      try {
        const after = await cmd.ls(input.cwd);
        if (
          after.detached.length > 0 ||
          blocks(after).some((each) => each.block.id === endpoint.paneId)
        )
          throw new Error("closed block is still present or detached placement is ambiguous");
      } catch (cause) {
        throw new TernOutcomeUnknownError("brief close", cause);
      }
      return { closed: true, warnings: [] };
    });
  };
  const toggleBoard = async (input: ViewHostingInput, project: string): Promise<boolean> => {
    const cmd = await scoped(input);
    const source = blocks(await cmd.ls(input.cwd)).find(
      (entry) => entry.block.id === (input.origin?.paneId ?? input.coordinator.paneId),
    );
    if (source?.block.program !== "tandem.board") return false;
    await open(input, project, "panel", "return", nativeViewsPath(input.home, project));
    return true;
  };
  return {
    open,
    scoped,
    close,
    toggleBoard,
    closeView: async (input: Parameters<TerminalBackend["closeView"]>[0]) =>
      close(input, await projectForView(input.home, input.coordinator)),
    openView: async (input: ViewHostingInput) => {
      const project = await projectForView(input.home, input.coordinator);
      if (input.view.kind === "browser") {
        const url = new URL(input.view.url);
        if (url.protocol !== "https:") throw new Error("PR links require an HTTPS URL");
        const cmd = await scoped(input);
        const ownerId = Number(input.coordinator.paneId);
        if (!Number.isSafeInteger(ownerId))
          throw new Error("Browser owner id is not exactly representable");
        await options.guard(input.coordinator.paneId, async () => {
          await withSettledOpens(
            cmd,
            input.coordinator,
            { cwd: input.cwd, home: input.home, index: nativeViewsPath(input.home, project) },
            options.clock,
            async () => {
              const before = blocks(await cmd.ls(input.cwd));
              await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
              // Nothing can later prove or disprove a browser opening, and it is never
              // re-invoked, so an unconfirmed one is reported once and pauses nothing.
              try {
                const opened = await cmd.mutate(
                  input.cwd,
                  ["browser", JSON.stringify({ op: "open", owner: ownerId, url: url.href })],
                  BrowserOpened,
                );
                const listing = await cmd.ls(input.cwd);
                const created = blocks(listing).find((entry) => entry.block.id === opened.ok.block);
                if (
                  listing.detached.length > 0 ||
                  !created ||
                  created.session.id !== input.coordinator.terminalSessionId ||
                  before.some((entry) => entry.block.id === opened.ok.block)
                )
                  throw new Error("new browser identity was not confirmed");
              } catch (cause) {
                throw new BrowserOpenUnconfirmedError(cause);
              }
            },
          );
        });
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
          nativeViewsPath(input.home, project),
        );
        return { opened: true, warnings: returned.warnings ?? [] };
      }
      // A new draft can open before the coordinator's background index publication.
      const detail =
        input.view.kind === "brief"
          ? nativeBriefFile(input.view.requestId)
          : detailForView(await readNativeBundle(input.home, project), input.view);
      if (["task", "brief", "pr"].includes(input.view.kind) && detail === undefined)
        throw new Error(`Native ${input.view.kind} detail is not ready`);
      const path =
        detail === undefined
          ? nativeViewsPath(input.home, project)
          : nativeDetailPath(input.home, project, detail);
      const opened = await open(
        input,
        project,
        input.view.kind,
        input.view.kind === "task"
          ? "task"
          : input.view.kind === "brief" ||
              input.view.kind === "pr" ||
              input.view.kind === "prs" ||
              input.view.kind === "task-picker"
            ? "split"
            : "window",
        path,
      );
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
