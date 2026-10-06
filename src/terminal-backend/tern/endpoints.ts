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
  if (endpoint.terminalSessionId !== undefined && found.session.id !== endpoint.terminalSessionId)
    throw new EndpointOwnershipError(endpoint, "Tern session identity changed");
  if (found.tab.id !== endpoint.workspaceId || found.tab.id !== endpoint.tabId) {
    throw new EndpointOwnershipError(endpoint, "Tern tab identity changed");
  }
  return found;
}
async function readForegroundGroup(commands: TernCommands, target: EndpointTarget, group: number) {
  const request = {
    argv: [
      process.execPath,
      fileURLToPath(new URL("./process-reader.ts", import.meta.url)),
      String(group),
    ],
    cwd: target.cwd,
  };
  const result = await commands.run(request);
  if (result.code !== 0)
    throw new AdapterCommandError("Tern foreground process proof", request, result);
  return decode(
    result.stdout,
    z.array(
      z.object({ pid: z.number().int().positive(), name: z.string(), argv: z.array(z.string()) }),
    ),
    "Tern foreground process proof",
  );
}

export async function inspect(
  commands: TernCommands,
  target: EndpointTarget,
): Promise<EndpointInspection> {
  const found = await exactPane(commands, target);
  let proc = await commands.read(target.cwd, ["process", target.endpoint.paneId], Processes);
  let nativeProcesses: readonly { pid: number; name: string; argv: string[] }[] = [];
  for (let attempt = 0; ; attempt += 1) {
    if (proc.pane !== target.endpoint.paneId)
      throw new EndpointOwnershipError(target.endpoint, "Tern process response names another pane");
    try {
      nativeProcesses =
        proc.group === null ? [] : await readForegroundGroup(commands, target, proc.group);
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
      break;
    } catch (error) {
      if (!(error instanceof AdapterProtocolError || error instanceof AdapterCommandError))
        throw error;
      // A shell can exec or switch foreground groups between the two independent reads.
      // Retry reads only when fresh exact-pane evidence proves the process snapshot changed.
      // A stable disagreement still fails closed, as does continuous churn.
      await exactPane(commands, target);
      const current = await commands.read(
        target.cwd,
        ["process", target.endpoint.paneId],
        Processes,
      );
      if (attempt >= 2 || JSON.stringify(current) === JSON.stringify(proc)) throw error;
      proc = current;
    }
  }
  const foregroundProcesses = nativeProcesses.map((entry) => ({
    ...entry,
    argv0: entry.argv[0],
    commandLine: undefined,
  }));
  // Daemon-hosted Tandem blocks have no PTY. Only the native program identity proves
  // this exception; a title or partial/contradictory process response never does.
  const tandemBlock =
    /^tandem\.[a-z][a-z0-9-]*$/u.test(found.block.program ?? "") &&
    proc.child === null &&
    proc.group === null &&
    proc.foreground === null;
  // A live pane without native process evidence is ambiguous, never assumed idle.
  if (found.block.live && proc.child === null && !tandemBlock)
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
      (found.block.live && proc.foreground === null && !tandemBlock) ||
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
function environmentAssignments(endpoint: Endpoint, env?: Readonly<Record<string, string>>) {
  return Object.entries({
    ...env,
    TANDEM_SESSION: endpoint.sessionId,
    TANDEM_TERN_WORKSPACE_ID: endpoint.workspaceId,
    TERN_PANE: endpoint.paneId,
  }).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new TypeError(`invalid environment key ${key}`);
    return `${key}=${value}`;
  });
}

/** Initialize the created shell after Tern acknowledges its actual tab and block ids. */
export async function initializeShell(
  commands: TernCommands,
  target: EndpointTarget & Readonly<{ env?: Readonly<Record<string, string>> }>,
): Promise<void> {
  const command = quoteShellCommand([
    "export",
    ...environmentAssignments(target.endpoint, target.env),
  ]);
  await paneMutation(commands, target, ["run", target.endpoint.paneId, command]);
}

export async function runCommand(
  commands: TernCommands,
  target: EndpointTarget &
    Readonly<{ command: readonly string[]; env?: Readonly<Record<string, string>> }>,
): Promise<void> {
  const assignments = environmentAssignments(target.endpoint, target.env);
  const command = quoteShellCommand(
    assignments.length === 0 ? target.command : ["env", ...assignments, ...target.command],
  );
  await paneMutation(commands, target, ["run", target.endpoint.paneId, command]);
}
export async function close(
  commands: TernCommands,
  target: EndpointTarget & Readonly<{ force?: boolean }>,
  owned = false,
  timing: Readonly<{ clock: () => number; wait: (milliseconds: number) => Promise<void> }> = {
    clock: Date.now,
    wait: Bun.sleep,
  },
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
    const deadline = timing.clock() + 5_000;
    for (;;) {
      const remaining = deadline - timing.clock();
      if (remaining <= 0)
        throw new Error("killed session cleanup was not confirmed before timeout");
      const listing = await commands.ls(target.cwd, remaining);
      if (listing.detached.length > 0)
        throw new Error("detached blocks prevent exact session absence proof");
      const retained = listing.sessions.find((entry) => entry.id === rechecked.id);
      // Tern keeps its last session alive. Exact ack plus no tabs/panes is known cleanup.
      if (retained === undefined || retained.tabs.length === 0) return;
      if (retained.tabs.some((tab) => tab.blocks.length > 0))
        throw new Error("killed session acquired panes");
      await timing.wait(Math.min(100, Math.max(0, deadline - timing.clock())));
    }
  } catch (cause) {
    throw new TernOutcomeUnknownError("tern close verification", cause);
  }
}
