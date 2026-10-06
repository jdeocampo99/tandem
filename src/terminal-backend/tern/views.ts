import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AdapterError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import type { NativeNavigationModel } from "../../board/native-file.ts";
import type { Endpoint } from "../../contracts.ts";
import type { TerminalBackend } from "../contract.ts";
import { exactPane } from "./endpoints.ts";
import {
  BlockAck,
  blocks,
  Id,
  Processes,
  type TernCommands,
  TernOutcomeUnknownError,
} from "./protocol.ts";
import { exactNativeView, withNativeOpenIntent } from "./view-intent.ts";

const Opened = z.object({
  blocks: z.array(z.union([Id, z.number().int().safe().positive().transform(String)])),
  discarded: z.boolean(),
});
const Receipt = z.object({ paneId: Id, tabId: Id, sessionId: Id });
const BrowserOpened = z.object({ ok: z.object({ block: Id }) });
const Clients = z.object({ clients: z.array(z.object({ kind: z.string() })) });
const windowPrograms = new Set(["tandem.board", "tandem.usage", "tandem.catchup"]);
const returnPrograms = new Set(
  [
    "panel",
    "task",
    "brief",
    "pr",
    "prs",
    "board",
    "usage",
    "catchup",
    "welcome",
    "task-picker",
  ].map((kind) => `tandem.${kind}`),
);
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
    return Object.values(bundle.pullRequests).find((pr) => pr.header.taskId === view.taskId)
      ?.detailFile;
  return undefined;
}

/** File routes are the sole CLI-to-block launch port. An uncertain invocation is never repeated. */
export function ternViewHost(
  commands: TernCommands,
  options: {
    wait: (ms: number) => Promise<void>;
    clock: () => number;
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
    const { ternCommands } = await import("./protocol.ts");
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
    kind:
      | "panel"
      | "task"
      | "task-picker"
      | "brief"
      | "pr"
      | "prs"
      | "board"
      | "usage"
      | "catchup"
      | "welcome",
    placement: "panel" | "split" | "task" | "window" | "return" | "inbox",
    path: string,
  ) => {
    const { ensurePrivateDirectoryTree } = await import("../../coordinator/lock.ts");
    const { nativeViewsPath } = await import("../../board/snapshot.ts");
    const cmd = await scoped(input);
    return options.guard(input.coordinator.paneId, async () => {
      const indexPath = nativeViewsPath(input.home, project);
      const args = [
        path,
        input.coordinator.paneId,
        input.cwd,
        input.origin?.windowId ?? "",
        indexPath,
      ];
      return withNativeOpenIntent({ ...input, indexPath }, cmd, async (intent) => {
        const reused =
          placement === "panel" || intent.recovered
            ? await exactNativeView(cmd, input.cwd, input.coordinator, kind, placement, args)
            : undefined;
        if (reused !== undefined) return { paneId: reused.block.id, project };
        let closeOrigin: string | undefined;
        let proveClosingOrigin: (() => Promise<void>) | undefined;
        if (
          placement === "return" &&
          input.origin?.paneId !== undefined &&
          input.origin.paneId !== input.coordinator.paneId
        ) {
          const source = blocks(await cmd.ls(input.cwd)).find(
            (entry) => entry.block.id === input.origin?.paneId,
          );
          if (
            source?.block.program === undefined ||
            !returnPrograms.has(source.block.program) ||
            source.block.args?.[1] !== input.coordinator.paneId ||
            source.block.args?.[4] !== indexPath
          )
            throw new EndpointOwnershipError(
              input.coordinator,
              "return origin is not this coordinator's native view",
            );
          if (windowPrograms.has(source.block.program)) {
            const endpoint: Endpoint = {
              ...input.coordinator,
              paneId: source.block.id,
              workspaceId: source.tab.id,
              tabId: source.tab.id,
            };
            const expected = [
              indexPath,
              input.coordinator.paneId,
              input.cwd,
              source.block.args?.[3] ?? "",
              indexPath,
            ];
            const proveClosingIdentity = async () => {
              const current = await exactPane(cmd, { endpoint, cwd: input.cwd });
              if (
                current.block.program !== source.block.program ||
                JSON.stringify(current.block.args) !== JSON.stringify(expected)
              )
                throw new EndpointOwnershipError(
                  endpoint,
                  "return origin is not the exact full-window view",
                );
            };
            proveClosingOrigin = async () => {
              await proveClosingIdentity();
              const process = await cmd.read(input.cwd, ["process", endpoint.paneId], Processes);
              if (
                process.pane !== endpoint.paneId ||
                process.child !== null ||
                process.foreground !== null ||
                process.group !== null
              )
                throw new EndpointBusyError(endpoint);
              await proveClosingIdentity();
            };
            await proveClosingOrigin();
            closeOrigin = source.block.id;
          }
        }
        const existingTasks =
          placement === "task" || placement === "return"
            ? blocks(await cmd.ls(input.cwd)).filter(
                (entry) =>
                  entry.tab.id === input.coordinator.tabId &&
                  entry.block.program === "tandem.task" &&
                  entry.block.args?.[1] === input.coordinator.paneId &&
                  entry.block.args?.[4] === indexPath,
              )
            : [];
        if (existingTasks.length > 1)
          throw new EndpointOwnershipError(
            input.coordinator,
            "several task blocks claim this coordinator",
          );
        const replaced = existingTasks[0]?.block.id;
        const directory = join(input.home, "native-host");
        await ensurePrivateDirectoryTree(directory, "native route directory");
        const token = randomUUID();
        const route = join(directory, `${token}.tandem-open.json`);
        const receipt = join(directory, `${token}.receipt.json`);
        await intent.claim(route, {
          version: 1,
          kind,
          placement,
          args,
          coordinator: input.coordinator.paneId,
          session: Id.parse(input.coordinator.terminalSessionId),
          receipt,
        });
        // Keep the final exact-id read immediately before focus. A failed read safely
        // cancels this invocation's intent because no mutation has been attempted.
        await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
        intent.markMutationAttempted();
        const focused = await cmd.mutate(input.cwd, ["focus", input.coordinator.paneId], BlockAck);
        if (focused.block !== input.coordinator.paneId)
          throw new TernOutcomeUnknownError("tern focus", "acknowledgement names another block");
        // Freshly revealed background tabs receive their real window size asynchronously.
        await options.wait(150);
        const columns = (await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd }))
          .block.cols;
        await writeFile(
          route,
          JSON.stringify({
            version: 1,
            kind,
            placement,
            args,
            columns,
            origin: input.origin?.paneId ?? input.coordinator.paneId,
            coordinator: input.coordinator.paneId,
            session: input.coordinator.terminalSessionId,
            receipt,
            replaced,
            closeOrigin,
          }),
          { flag: "wx", mode: 0o600 },
        );
        // Recheck immediately before the opening effect.
        await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
        await proveClosingOrigin?.();
        let acknowledgement: z.infer<typeof Opened> | undefined;
        try {
          const request = cmd.request(input.cwd, ["open", route]);
          const outcome = await cmd.run(request);
          if (outcome.code === 0) acknowledgement = Opened.parse(JSON.parse(outcome.stdout));
          else if (!outcome.stderr.includes("cannot open in a file block"))
            throw new Error(outcome.stderr);
          // Tern's CLI reports handled custom layout routes as no file block. The private
          // receipt and exact program/args proof below are required even when the CLI exits 0.
        } catch (cause) {
          throw new TernOutcomeUnknownError("tern open", cause);
        }

        const deadline = options.clock() + 5000;
        let result: z.infer<typeof Receipt> | undefined;
        while (options.clock() < deadline) {
          try {
            result = Receipt.parse(JSON.parse(await readFile(receipt, "utf8")));
            break;
          } catch {
            await options.wait(50);
          }
        }
        if (result === undefined)
          throw new TernOutcomeUnknownError(
            "tern open",
            "route receipt was not confirmed; keep route and resources",
          );
        const listing = await cmd.ls(input.cwd).catch((cause: unknown) => {
          throw new TernOutcomeUnknownError("tern open", cause);
        });
        const entry = blocks(listing).find((each) => each.block.id === result.paneId);
        if (
          (placement === "return" && result.paneId !== input.coordinator.paneId) ||
          (closeOrigin !== undefined &&
            (listing.detached.length > 0 ||
              blocks(listing).some((each) => each.block.id === closeOrigin))) ||
          (acknowledgement !== undefined &&
            acknowledgement.blocks.length > 0 &&
            !acknowledgement.blocks.includes(result.paneId)) ||
          entry === undefined ||
          entry.tab.id !== result.tabId ||
          entry.session.id !== result.sessionId ||
          result.sessionId !== input.coordinator.terminalSessionId ||
          (!["return", "inbox"].includes(placement) &&
            (entry.block.program !== `tandem.${kind}` ||
              JSON.stringify(entry.block.args) !== JSON.stringify(args)))
        )
          throw new TernOutcomeUnknownError(
            "tern open",
            "created block identity or arguments changed",
          );
        const confirmed = await exactNativeView(
          cmd,
          input.cwd,
          input.coordinator,
          kind,
          placement,
          args,
        );
        if (confirmed !== undefined && confirmed.block.id !== result.paneId)
          throw new TernOutcomeUnknownError("tern open", "native evidence names another block");
        if (!["return", "inbox"].includes(placement) && confirmed === undefined)
          throw new TernOutcomeUnknownError(
            "tern open",
            "native block disappeared during verification",
          );
        await intent.settle();
        return { paneId: result.paneId, project };
      });
    });
  };
  const close = async (input: Parameters<TerminalBackend["closeView"]>[0], project: string) => {
    const { nativeDetailPath, nativeViewsPath } = await import("../../board/snapshot.ts");
    const { nativeBriefFile } = await import("../../board/native-views.ts");
    if (input.origin.paneId === input.coordinator.paneId)
      throw new EndpointOwnershipError(
        input.coordinator,
        "cannot retire the conversation as a brief",
      );
    const cmd = await scoped(input, true);
    return options.guard(input.coordinator.paneId, async () => {
      const args = [
        nativeDetailPath(input.home, project, nativeBriefFile(input.view.requestId)),
        input.coordinator.paneId,
        input.cwd,
        input.origin.windowId ?? "",
        nativeViewsPath(input.home, project),
      ];
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
    const { nativeViewsPath } = await import("../../board/snapshot.ts");
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
      const { nativeDetailPath, nativeViewsPath } = await import("../../board/snapshot.ts");
      const { readNativeBundle } = await import("../../board/native-file.ts");
      const project = await projectForView(input.home, input.coordinator);
      if (input.view.kind === "browser") {
        const url = new URL(input.view.url);
        if (url.protocol !== "https:") throw new Error("PR links require an HTTPS URL");
        const cmd = await scoped(input);
        const ownerId = Number(input.coordinator.paneId);
        if (!Number.isSafeInteger(ownerId))
          throw new Error("Browser owner id is not exactly representable");
        await options.guard(input.coordinator.paneId, async () => {
          await withNativeOpenIntent(
            { ...input, indexPath: nativeViewsPath(input.home, project) },
            cmd,
            async (intent) => {
              const before = blocks(await cmd.ls(input.cwd));
              await intent.claimBrowser({
                url: url.href,
                ...(input.origin?.windowId === undefined
                  ? {}
                  : { windowId: input.origin.windowId }),
              });
              await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
              intent.markMutationAttempted();
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
                throw new TernOutcomeUnknownError(
                  "tern browser",
                  "new browser identity was not confirmed",
                );
              await intent.settle();
            },
          );
        });
        return { opened: true, warnings: [] };
      }
      if (input.view.kind === "board" && (await toggleBoard(input, project)))
        return { opened: true, warnings: [] };
      if (input.view.kind === "orchestrator" || input.view.kind === "inbox") {
        await open(
          input,
          project,
          "panel",
          input.view.kind === "inbox" ? "inbox" : "return",
          nativeViewsPath(input.home, project),
        );
        return { opened: true, warnings: [] };
      }
      const bundle = await readNativeBundle(input.home, project);
      const detail = detailForView(bundle, input.view);
      if (["task", "brief", "pr"].includes(input.view.kind) && detail === undefined)
        throw new Error(`Native ${input.view.kind} detail is not ready`);
      const path =
        detail === undefined
          ? nativeViewsPath(input.home, project)
          : nativeDetailPath(input.home, project, detail);
      await open(
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
      return { opened: true, warnings: [] };
    },
  };
}
