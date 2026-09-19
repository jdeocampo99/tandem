import { basename } from "node:path";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import { commandErrorCode, parseJson } from "./ownership.ts";
import { type CoordinatorRecord, isRecord } from "./record.ts";

export function coordinatorWorkspaceLabel(repoPath: string): string {
  return `Tandem coordinator · ${basename(repoPath)}`;
}

/** Retire our generated label without closing retained terminals or changing custom labels. */
export async function retireCoordinatorWorkspace(
  run: CommandRunner,
  record: Pick<CoordinatorRecord, "repoPath" | "endpoint">,
): Promise<void> {
  const { sessionId, workspaceId } = record.endpoint;
  const getRequest: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "workspace", "get", workspaceId],
    cwd: record.repoPath,
  };
  const current = await run(getRequest);
  if (current.code !== 0) {
    const code = commandErrorCode(current.stdout, current.stderr);
    if (
      code === "workspace_not_found" ||
      code === "session_not_found" ||
      code === "server_not_running"
    )
      return;
    throw new AdapterCommandError("herdr workspace get", getRequest, current);
  }
  const value = parseJson(current.stdout, "herdr workspace get");
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    value.result.type !== "workspace_info" ||
    !isRecord(value.result.workspace) ||
    value.result.workspace.workspace_id !== workspaceId
  ) {
    throw new Error("Herdr returned an unknown coordinator workspace identity");
  }
  if (value.result.workspace.label !== coordinatorWorkspaceLabel(record.repoPath)) return;
  const label = `Retained terminals · ${basename(record.repoPath)}`;
  const renameRequest: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "workspace", "rename", workspaceId, label],
    cwd: record.repoPath,
  };
  const renamed = await run(renameRequest);
  if (renamed.code !== 0) {
    throw new AdapterCommandError("herdr workspace rename", renameRequest, renamed);
  }
  const acknowledgement = parseJson(renamed.stdout, "herdr workspace rename");
  if (
    !isRecord(acknowledgement) ||
    !isRecord(acknowledgement.result) ||
    acknowledgement.result.type !== "workspace_info" ||
    !isRecord(acknowledgement.result.workspace) ||
    acknowledgement.result.workspace.workspace_id !== workspaceId ||
    acknowledgement.result.workspace.label !== label
  ) {
    throw new Error("Herdr did not acknowledge the retained workspace label");
  }
}
