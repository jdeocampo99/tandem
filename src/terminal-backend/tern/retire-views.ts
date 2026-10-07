import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { EndpointOwnershipError } from "../../adapters/primitives.ts";
import { findRecordedOwner } from "../../coordinator/recorded-owner.ts";
import { quarantineCoordinatorLease } from "../../coordinator/resources.ts";
import { isWindowView, parseBlockArgs, ViewKind } from "../../native/block.ts";
import { viewDetailPath, viewIndexPath } from "../../native/store.ts";
import type { EndpointTarget } from "../contract.ts";
import { ternEndpoint } from "../identity.ts";
import type { TernCli } from "./cli.ts";
import { blocks, type LocatedBlock, TernOutcomeUnknownError } from "./protocol.ts";

const detailKinds: readonly ViewKind[] = ["task", "brief", "pr", "setup"];

async function recordedCoordinator(home: string, target: EndpointTarget) {
  const owner = await findRecordedOwner(home, {
    by: "pane",
    pane: { ...target.endpoint, terminal: "tern" },
    cwd: target.cwd,
  });
  return owner.status === "owned" ? owner.record : undefined;
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
  commands: TernCli,
  home: string | undefined,
  target: EndpointTarget,
): Promise<() => Promise<void>> {
  if (target.endpoint.role !== "coordinator")
    return async () => {
      // Only a coordinator owns views to retire.
    };
  const listing = await commands.ls(target.cwd);
  if (listing.detached.length > 0)
    throw new EndpointOwnershipError(
      target.endpoint,
      "detached blocks prevent coordinator view retirement",
    );
  const claims = blocks(listing).filter(
    (entry) =>
      entry.block.program?.startsWith("tandem.") &&
      parseBlockArgs(entry.block.args)?.ctx.coordinator === target.endpoint.paneId,
  );
  if (claims.length === 0)
    return async () => {
      // No view claims this coordinator.
    };
  if (home === undefined)
    throw new EndpointOwnershipError(target.endpoint, "view retirement requires its recorded home");
  const owner = await recordedCoordinator(home, target);
  if (owner === undefined)
    throw new EndpointOwnershipError(target.endpoint, "views have no unique recorded coordinator");
  const index = viewIndexPath(home, owner.repoPath);
  const coordinator = ternEndpoint(target.endpoint);
  const endpointFor = (entry: LocatedBlock) =>
    ternEndpoint({
      ...target.endpoint,
      workspaceId: entry.tab.id,
      tabId: entry.tab.id,
      paneId: entry.block.id,
    });
  for (const entry of claims) {
    const kind = ViewKind.safeParse(entry.block.program?.slice("tandem.".length));
    const listed = parseBlockArgs(entry.block.args);
    const file = listed?.viewPath ?? "";
    const expectedFile =
      kind.success && detailKinds.includes(kind.data)
        ? basename(file).startsWith(`${kind.data}-`)
          ? viewDetailPath(home, owner.repoPath, basename(file))
          : undefined
        : index;
    if (
      !kind.success ||
      listed === undefined ||
      entry.block.id === target.endpoint.paneId ||
      entry.session.id !== target.endpoint.terminalSessionId ||
      (isWindowView(kind.data, file)
        ? entry.tab.id === target.endpoint.tabId
        : entry.tab.id !== target.endpoint.tabId) ||
      file !== expectedFile ||
      listed.ctx.coordinator !== target.endpoint.paneId ||
      listed.ctx.cwd !== target.cwd ||
      listed.ctx.index !== index
    )
      throw new EndpointOwnershipError(
        endpointFor(entry),
        "pane is not an exact coordinator-owned native view",
      );
    await commands.proveView({
      endpoint: endpointFor(entry),
      cwd: target.cwd,
      program: entry.block.program ?? "",
      args: entry.block.args ?? [],
    });
  }
  return async () => {
    try {
      for (const entry of claims)
        await commands.mutate({
          verb: "close",
          endpoint: endpointFor(entry),
          cwd: target.cwd,
          view: { program: entry.block.program ?? "", args: entry.block.args ?? [] },
          owner: coordinator,
        });
      const after = await commands.ls(target.cwd).catch((cause: unknown) => {
        throw new TernOutcomeUnknownError("view retirement verification", cause);
      });
      if (
        after.detached.length > 0 ||
        blocks(after).some(
          (p) =>
            p.block.program?.startsWith("tandem.") &&
            parseBlockArgs(p.block.args)?.ctx.coordinator === target.endpoint.paneId,
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
