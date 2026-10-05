import { fileURLToPath } from "node:url";
import { z } from "zod";
import { quoteShellCommand } from "../../adapters/commands.ts";
import {
  AdapterCommandError,
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import type { Endpoint } from "../../contracts.ts";
import { type EndpointInspection, type EndpointTarget, isWorkerProcess } from "../contract.ts";
import {
  BlockAck,
  blocks,
  decode,
  type LocatedBlock,
  Processes,
  SessionAck,
  type TernCommands,
  TernOutcomeUnknownError,
} from "./protocol.ts";

export function missing(endpoint: Endpoint): EndpointOwnershipError {
  return new EndpointOwnershipError(
    endpoint,
    "exact Tern id absent from the same scoped listing",
    "missing",
  );
}
export async function exactPane(
  commands: TernCommands,
  target: EndpointTarget,
): Promise<LocatedBlock> {
  const { endpoint } = target;
  const listing = await commands.ls(target.cwd);
  const found = blocks(listing).find((entry) => entry.block.id === endpoint.paneId);
  if (found === undefined && listing.detached.length > 0)
    throw new EndpointOwnershipError(
      endpoint,
      "detached Tern blocks leave the pane's placement ambiguous",
    );
  if (found === undefined) throw missing(endpoint);
  if (found.tab.id !== endpoint.workspaceId || found.tab.id !== endpoint.tabId) {
    throw new EndpointOwnershipError(endpoint, "Tern tab identity changed");
  }
  return found;
}
export async function inspect(
  commands: TernCommands,
  target: EndpointTarget,
): Promise<EndpointInspection> {
  const found = await exactPane(commands, target);
  const proc = await commands.read(target.cwd, ["process", target.endpoint.paneId], Processes);
  if (proc.pane !== target.endpoint.paneId)
    throw new EndpointOwnershipError(target.endpoint, "Tern process response names another pane");
  const nativeProcesses =
    proc.group === null
      ? []
      : await (async () => {
          const request = {
            argv: [
              process.execPath,
              fileURLToPath(new URL("./process-reader.ts", import.meta.url)),
              String(proc.group),
            ],
            cwd: target.cwd,
          };
          const result = await commands.run(request);
          if (result.code !== 0)
            throw new AdapterCommandError("Tern foreground process proof", request, result);
          return decode(
            result.stdout,
            z.array(
              z.object({
                pid: z.number().int().positive(),
                name: z.string(),
                argv: z.array(z.string()),
              }),
            ),
            "Tern foreground process proof",
          );
        })();
  if (
    proc.foreground !== null &&
    !nativeProcesses.some(
      (entry) =>
        entry.pid === proc.foreground?.pid &&
        JSON.stringify(entry.argv) === JSON.stringify(proc.foreground.argv),
    )
  )
    throw new AdapterProtocolError(
      "Tern foreground process proof",
      "Tern leader and native group evidence disagree",
      "",
    );
  const foregroundProcesses = nativeProcesses.map((entry) => ({
    ...entry,
    argv0: entry.argv[0],
    commandLine: undefined,
  }));
  // A live pane without native process evidence is ambiguous, never assumed idle.
  if (found.block.live && proc.child === null)
    throw new AdapterProtocolError("tern process", "live block has no child process", "");
  return {
    endpoint: target.endpoint,
    pane: {
      paneId: found.block.id,
      workspaceId: found.tab.id,
      tabId: found.tab.id,
      foregroundCwd: proc.foreground?.cwd ?? proc.child?.cwd ?? found.block.cwd,
    },
    processInfo: {
      paneId: proc.pane,
      shellPid: proc.child?.pid,
      foregroundProcessGroupId: proc.group ?? undefined,
      foregroundProcesses,
    },
    activeWorker:
      (proc.foreground !== null && proc.child !== null && proc.foreground.pid !== proc.child.pid) ||
      foregroundProcesses.some(isWorkerProcess) ||
      (found.block.live && proc.foreground === null) ||
      (proc.child !== null &&
        isWorkerProcess({ ...proc.child, argv0: proc.child.argv[0], commandLine: undefined })),
  };
}
export async function paneMutation(
  commands: TernCommands,
  target: EndpointTarget,
  args: readonly string[],
): Promise<void> {
  await exactPane(commands, target);
  const ack = await commands.mutate(target.cwd, args, BlockAck);
  if (ack.block !== target.endpoint.paneId)
    throw new TernOutcomeUnknownError(`tern ${args[0]}`, "acknowledgement names another block");
}
export async function runCommand(
  commands: TernCommands,
  target: EndpointTarget &
    Readonly<{ command: readonly string[]; env?: Readonly<Record<string, string>> }>,
): Promise<void> {
  const assignments = Object.entries({
    ...target.env,
    TANDEM_SESSION: target.endpoint.sessionId,
    TANDEM_TERN_WORKSPACE_ID: target.endpoint.workspaceId,
    TERN_PANE: target.endpoint.paneId,
  }).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new TypeError(`invalid environment key ${key}`);
    return `${key}=${value}`;
  });
  const command = quoteShellCommand(
    assignments.length === 0 ? target.command : ["env", ...assignments, ...target.command],
  );
  await paneMutation(commands, target, ["run", target.endpoint.paneId, command]);
}
export async function close(
  commands: TernCommands,
  target: EndpointTarget & Readonly<{ force?: boolean }>,
  owned = false,
): Promise<void> {
  let initial: EndpointInspection;
  try {
    initial = await inspect(commands, target);
  } catch (error) {
    if (!owned && error instanceof EndpointOwnershipError && error.reason === "missing") return;
    throw error;
  }
  if (initial.activeWorker && target.force !== true) throw new EndpointBusyError(target.endpoint);
  // This is the last call before close: recheck the exact identity, never use a title fallback.
  const before = await exactPane(commands, target);
  const ack = await commands.mutate(target.cwd, ["close", target.endpoint.paneId], BlockAck);
  if (ack.block !== target.endpoint.paneId)
    throw new TernOutcomeUnknownError("tern close", "acknowledgement names another block");
  try {
    const after = await commands.ls(target.cwd);
    if (after.detached.length > 0) throw new Error("detached blocks prevent exact absence proof");
    if (blocks(after).some((entry) => entry.block.id === target.endpoint.paneId))
      throw new Error("closed block remains present");
    const session = after.sessions.find((entry) => entry.id === before.session.id);
    if (session === undefined || session.tabs.some((tab) => tab.blocks.length > 0)) return;
    // Empty sessions survive the last close in Tern. Recheck exact id and emptiness before kill.
    const rechecked = (await commands.ls(target.cwd)).sessions.find(
      (entry) => entry.id === before.session.id,
    );
    if (rechecked === undefined) return;
    if (rechecked.tabs.some((tab) => tab.blocks.length > 0)) return;
    const killed = await commands.mutate(target.cwd, ["kill", "session", rechecked.id], SessionAck);
    if (killed.session !== rechecked.id) throw new Error("kill acknowledged another session");
    // Tern 0.4.5 preserves its sole empty session after an acknowledged kill. The exact
    // pane and tab must still be gone; retain that known-empty session without retrying.
    const retained = (await commands.ls(target.cwd)).sessions.find(
      (entry) => entry.id === rechecked.id,
    );
    if (retained?.tabs.some((tab) => tab.blocks.length > 0))
      throw new Error("killed session acquired panes");
  } catch (cause) {
    throw new TernOutcomeUnknownError("tern close verification", cause);
  }
}
