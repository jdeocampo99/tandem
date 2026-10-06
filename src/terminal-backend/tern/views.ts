import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AdapterError, EndpointOwnershipError } from "../../adapters/primitives.ts";
import { type NativeNavigationModel, readNativeBundle } from "../../board/native-file.ts";
import { nativeDetailPath, nativeViewsPath } from "../../board/snapshot.ts";
import type { Endpoint } from "../../contracts.ts";
import { ensurePrivateDirectoryTree } from "../../coordinator/lock.ts";
import { listCoordinatorRecords } from "../../coordinator/registry.ts";
import type { TerminalBackend } from "../contract.ts";
import { exactPane, paneMutation } from "./endpoints.ts";
import { blocks, Id, type TernCommands, TernOutcomeUnknownError } from "./protocol.ts";

const Opened = z.object({
  blocks: z.array(z.union([Id, z.number().int().safe().positive().transform(String)])),
  discarded: z.boolean(),
});
const Receipt = z.object({ paneId: Id, tabId: Id, sessionId: Id });
const Clients = z.object({ clients: z.array(z.object({ kind: z.string() })) });
const returnPrograms = new Set(
  ["panel", "task", "brief", "pr", "prs", "board", "usage", "catchup", "welcome"].map(
    (kind) => `tandem.${kind}`,
  ),
);
export type ViewHostingInput = Parameters<TerminalBackend["openView"]>[0];

export async function projectForView(home: string, coordinator: Endpoint): Promise<string> {
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
  const scoped = async (input: ViewHostingInput) => {
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
    const origin = blocks(await cmd.ls(input.cwd)).find((entry) => entry.block.id === originId);
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
    kind: string,
    placement: "panel" | "split" | "task" | "window" | "return" | "inbox",
    path: string,
  ) => {
    const cmd = await scoped(input);
    return options.guard(input.coordinator.paneId, async () => {
      const indexPath = nativeViewsPath(input.home, project);
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
      await paneMutation(cmd, { endpoint: input.coordinator, cwd: input.cwd }, [
        "focus",
        input.coordinator.paneId,
      ]);
      // Freshly revealed background tabs receive their real window size asynchronously.
      await options.wait(150);
      const columns = (await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd })).block
        .cols;
      const args = [
        path,
        input.coordinator.paneId,
        input.cwd,
        input.origin?.windowId ?? "",
        indexPath,
      ];
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
        }),
        { flag: "wx", mode: 0o600 },
      );
      // Recheck immediately before the opening effect.
      await exactPane(cmd, { endpoint: input.coordinator, cwd: input.cwd });
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
      const entry = blocks(await cmd.ls(input.cwd)).find((each) => each.block.id === result.paneId);
      if (
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
      await rm(route);
      await rm(receipt);
      return { paneId: result.paneId, project };
    });
  };
  return {
    open,
    scoped,
    openView: async (input: ViewHostingInput) => {
      const project = await projectForView(input.home, input.coordinator);
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
          : input.view.kind === "brief" || input.view.kind === "pr" || input.view.kind === "prs"
            ? "split"
            : "window",
        path,
      );
      return { opened: true, warnings: [] };
    },
  };
}
