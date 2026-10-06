import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { EndpointBusyError, EndpointOwnershipError } from "../../adapters/primitives.ts";
import { nativeDetailPath, nativeViewsPath } from "../../board/snapshot.ts";
import type { Endpoint } from "../../contracts.ts";
import { listCoordinatorQuarantineRecords } from "../../coordinator/quarantine.ts";
import { listCoordinatorRecords } from "../../coordinator/registry.ts";
import { quarantineCoordinatorLease } from "../../coordinator/resources.ts";
import type { EndpointTarget } from "../contract.ts";
import { exactPane } from "./endpoints.ts";
import {
  BlockAck,
  blocks,
  type LocatedBlock,
  Processes,
  type TernCommands,
  TernOutcomeUnknownError,
} from "./protocol.ts";

const kinds = new Set([
  "panel",
  "welcome",
  "task",
  "task-picker",
  "brief",
  "pr",
  "prs",
  "board",
  "usage",
  "catchup",
]);
const windowKinds = new Set(["board", "usage", "catchup"]);

async function recordedCoordinator(home: string, target: EndpointTarget) {
  const owners = (await listCoordinatorRecords(home, target.endpoint.sessionId)).filter(
    (record) =>
      record.endpoint.terminal === "tern" &&
      record.endpoint.paneId === target.endpoint.paneId &&
      record.endpoint.terminalSessionId === target.endpoint.terminalSessionId &&
      record.endpoint.workspaceId === target.endpoint.workspaceId &&
      record.endpoint.tabId === target.endpoint.tabId &&
      record.endpoint.generation === target.endpoint.generation &&
      record.worktree.path === target.cwd,
  );
  const owner = owners[0];
  return owners.length === 1 ? owner : undefined;
}

/** Preserve a recorded coordinator when independent native identity evidence stays ambiguous. */
export async function quarantineCoordinatorProof(
  home: string | undefined,
  target: EndpointTarget,
  reason: string,
): Promise<void> {
  if (home === undefined || target.endpoint.role !== "coordinator") return;
  const owner = await recordedCoordinator(home, target);
  if (owner === undefined) return;
  await quarantineCoordinatorLease({
    home,
    sessionId: owner.endpoint.sessionId,
    repoPath: owner.repoPath,
    stage: "replacement",
    reason,
    lease: owner.worktree,
    endpoint: owner.endpoint,
    clock: () => new Date().toISOString(),
    newId: randomUUID,
  });
}

/** Preflight every native view before closing any part of its recorded coordinator. */
export async function planCoordinatorViews(
  commands: TernCommands,
  home: string | undefined,
  target: EndpointTarget,
): Promise<() => Promise<void>> {
  if (target.endpoint.role !== "coordinator") return async () => {};
  if (
    home !== undefined &&
    (await listCoordinatorQuarantineRecords(home)).some(
      (note) =>
        note.endpoint?.terminal === "tern" &&
        note.endpoint.paneId === target.endpoint.paneId &&
        note.endpoint.terminalSessionId === target.endpoint.terminalSessionId,
    )
  )
    throw new TernOutcomeUnknownError(
      "view retirement",
      "an earlier coordinator effect is quarantined",
    );
  const listing = await commands.ls(target.cwd);
  if (listing.detached.length > 0)
    throw new EndpointOwnershipError(
      target.endpoint,
      "detached blocks prevent coordinator view retirement",
    );
  const claims = blocks(listing).filter(
    (entry) =>
      entry.block.program?.startsWith("tandem.") &&
      entry.block.args?.[1] === target.endpoint.paneId,
  );
  if (claims.length === 0) return async () => {};
  if (home === undefined)
    throw new EndpointOwnershipError(target.endpoint, "view retirement requires its recorded home");
  const owner = await recordedCoordinator(home, target);
  if (owner === undefined)
    throw new EndpointOwnershipError(target.endpoint, "views have no unique recorded coordinator");
  const index = nativeViewsPath(home, owner.repoPath);
  const endpointFor = (entry: LocatedBlock): Endpoint => ({
    ...target.endpoint,
    workspaceId: entry.tab.id,
    tabId: entry.tab.id,
    paneId: entry.block.id,
  });
  const proveIdentity = async (entry: LocatedBlock) => {
    const endpoint = endpointFor(entry);
    const current = await exactPane(commands, { endpoint, cwd: target.cwd });
    const kind = entry.block.program?.slice("tandem.".length) ?? "";
    const args = entry.block.args;
    const file = args?.[0] ?? "";
    const expectedFile = ["task", "brief", "pr"].includes(kind)
      ? basename(file).startsWith(`${kind}-`)
        ? nativeDetailPath(home, owner.repoPath, basename(file))
        : undefined
      : index;
    if (
      !kinds.has(kind) ||
      endpoint.paneId === target.endpoint.paneId ||
      entry.session.id !== target.endpoint.terminalSessionId ||
      (windowKinds.has(kind)
        ? entry.tab.id === target.endpoint.tabId
        : entry.tab.id !== target.endpoint.tabId) ||
      args?.length !== 5 ||
      file !== expectedFile ||
      args[1] !== target.endpoint.paneId ||
      args[2] !== target.cwd ||
      args[4] !== index ||
      current.block.program !== entry.block.program ||
      JSON.stringify(current.block.args) !== JSON.stringify(args)
    )
      throw new EndpointOwnershipError(
        endpoint,
        "pane is not an exact coordinator-owned native view",
      );
  };
  const prove = async (entry: LocatedBlock) => {
    await proveIdentity(entry);
    const proc = await commands.read(target.cwd, ["process", entry.block.id], Processes);
    if (
      proc.pane !== entry.block.id ||
      proc.child !== null ||
      proc.group !== null ||
      proc.foreground !== null
    )
      throw new EndpointBusyError(endpointFor(entry));
    await proveIdentity(entry);
  };
  for (const entry of claims) await prove(entry);
  return async () => {
    try {
      for (const entry of claims) {
        await prove(entry);
        const ack = await commands.mutate(target.cwd, ["close", entry.block.id], BlockAck);
        if (ack.block !== entry.block.id)
          throw new TernOutcomeUnknownError("view retirement", "acknowledged another block");
        try {
          const after = await commands.ls(target.cwd);
          if (after.detached.length > 0 || blocks(after).some((p) => p.block.id === entry.block.id))
            throw new Error("closed native view is still present or detached");
        } catch (cause) {
          throw new TernOutcomeUnknownError("view retirement verification", cause);
        }
      }
      const after = await commands.ls(target.cwd).catch((cause: unknown) => {
        throw new TernOutcomeUnknownError("view retirement verification", cause);
      });
      if (
        after.detached.length > 0 ||
        blocks(after).some(
          (p) =>
            p.block.program?.startsWith("tandem.") && p.block.args?.[1] === target.endpoint.paneId,
        )
      )
        throw new TernOutcomeUnknownError(
          "view retirement",
          "coordinator acquired additional native views",
        );
    } catch (error) {
      if (error instanceof TernOutcomeUnknownError) {
        const quarantined = await quarantineCoordinatorLease({
          home,
          sessionId: owner.endpoint.sessionId,
          repoPath: owner.repoPath,
          stage: "replacement",
          reason: error.message,
          lease: owner.worktree,
          endpoint: owner.endpoint,
          clock: () => new Date().toISOString(),
          newId: randomUUID,
        });
        throw new TernOutcomeUnknownError(
          "view retirement",
          `${error.message}; saved ${quarantined.quarantinePath}`,
        );
      }
      throw error;
    }
  };
}
