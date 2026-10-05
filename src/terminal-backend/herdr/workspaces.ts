import { createConnection } from "node:net";
import {
  AdapterCommandError,
  AdapterProtocolError,
  checkedText,
  isRecord,
  optionalString,
  parseJson,
  requiredRecord,
  requiredString,
  runChecked,
} from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";
import { describeError, singleLine } from "../../service/records.ts";
import type {
  FocusResult,
  PaneListing,
  SessionPane,
  SessionTarget,
  WorkspaceListing,
} from "../contract.ts";
import { errorCode, herdrRequest, isSessionMissing, parseAnswer } from "./protocol.ts";

/** Herdr's socket effect, injected for isolated composition and tests. */
export type WorkspaceMoveRequest = Readonly<{
  socketPath: string;
  workspaceId: string;
  insertIndex: number;
}>;

export type WorkspaceMover = (request: WorkspaceMoveRequest) => Promise<unknown>;

const SOCKET_RESPONSE_LIMIT = 4 * 1024 * 1024;

type HerdrSessionStatus = Readonly<{ socketPath: string; running: boolean | undefined }>;
type HerdrWorkspaceMoveResponse = Readonly<{
  type: "workspace_list";
  workspaces: readonly WorkspaceListing[];
}>;

function parseWorkspaceList(
  payload: unknown,
  operation: string,
  response: string,
): readonly WorkspaceListing[] {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  if (!Array.isArray(result.workspaces)) {
    throw new AdapterProtocolError(operation, "result.workspaces must be an array", response);
  }
  return result.workspaces.map((entry, index) => {
    const workspace = requiredRecord(entry, `result.workspaces[${index}]`, operation, response);
    const label = optionalString(
      workspace.label,
      `result.workspaces[${index}].label`,
      operation,
      response,
    );
    const activeTabId = optionalString(
      workspace.active_tab_id,
      `result.workspaces[${index}].active_tab_id`,
      operation,
      response,
    );
    return {
      workspaceId: requiredString(
        workspace.workspace_id,
        `result.workspaces[${index}].workspace_id`,
        operation,
        response,
      ),
      ...(label === undefined ? {} : { label }),
      ...(activeTabId === undefined ? {} : { activeTabId }),
    };
  });
}

function parseHerdrStatus(
  payload: unknown,
  sessionId: string,
  operation: string,
  response: string,
  allowNotRunning = false,
): HerdrSessionStatus {
  const root = requiredRecord(payload, "response", operation, response);
  const server = requiredRecord(root.server, "server", operation, response);
  const socketPath = requiredString(server.socket, "server.socket", operation, response);
  if (!socketPath.startsWith("/")) {
    throw new AdapterProtocolError(
      operation,
      "server.socket must be an absolute Unix socket path",
      response,
    );
  }
  const runningValue = server.running;
  if (runningValue !== undefined && typeof runningValue !== "boolean") {
    throw new AdapterProtocolError(
      operation,
      "server.running must be boolean when present",
      response,
    );
  }
  if (runningValue === false && !allowNotRunning) {
    throw new AdapterProtocolError(
      operation,
      `Herdr session ${sessionId} is not running`,
      response,
    );
  }
  const reportedSession = optionalString(server.session, "server.session", operation, response);
  const reportedSessionId = optionalString(
    server.session_id,
    "server.session_id",
    operation,
    response,
  );
  if (
    (reportedSession !== undefined && reportedSession !== sessionId) ||
    (reportedSessionId !== undefined && reportedSessionId !== sessionId)
  ) {
    throw new AdapterProtocolError(
      operation,
      "status socket belongs to a different session",
      response,
    );
  }
  return { socketPath, running: runningValue };
}

async function readHerdrStatus(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  allowNotRunning = false,
): Promise<HerdrSessionStatus> {
  const request = herdrRequest(sessionId, cwd, ["status", "--json"]);
  const result = await runChecked(run, request, "herdr status");
  return parseHerdrStatus(
    parseJson(result.stdout, "herdr status"),
    sessionId,
    "herdr status",
    result.stdout,
    allowNotRunning,
  );
}

async function moveWorkspaceOverSocket(request: WorkspaceMoveRequest): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = createConnection({ path: request.socketPath });
  let buffer = "";
  let settled = false;
  const settleSuccess = (value: unknown): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  const settleFailure = (error: unknown): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(error);
  };
  socket.setTimeout(5_000, () => {
    settleFailure(new Error("timed out waiting for Herdr workspace.move response"));
  });
  socket.on("connect", () => {
    const message = `${JSON.stringify({
      id: "tandem-workspace-move",
      method: "workspace.move",
      params: { workspace_id: request.workspaceId, insert_index: request.insertIndex },
    })}\n`;
    socket.write(message);
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > SOCKET_RESPONSE_LIMIT) {
      settleFailure(new Error("Herdr workspace.move response exceeded capture bound"));
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    try {
      settleSuccess(JSON.parse(line));
    } catch (error) {
      settleFailure(error);
    }
  });
  socket.on("error", (error: Error) => {
    settleFailure(error);
  });
  socket.on("close", () => {
    if (!settled) settleFailure(new Error("Herdr workspace.move socket closed without a response"));
  });
  return promise;
}

function parseWorkspaceMoveResponse(
  value: unknown,
  operation: string,
  response: string,
): HerdrWorkspaceMoveResponse {
  const root = requiredRecord(value, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  if (result.type !== "workspace_list") {
    throw new AdapterProtocolError(operation, "result.type must be workspace_list", response);
  }
  return { type: "workspace_list", workspaces: parseWorkspaceList(value, operation, response) };
}

/** A field a complete listing requires: single-line text, trimmed, or the listing fails. */
function completeText(value: unknown, field: string, operation: string): string {
  try {
    return singleLine(value, field);
  } catch (error) {
    throw new Error(`${operation} ${field} is invalid: ${describeError(error)}`, { cause: error });
  }
}

function completeEntries(
  payload: unknown,
  key: "workspaces" | "panes",
  entry: "workspace" | "pane",
  operation: string,
): readonly Record<string, unknown>[] {
  if (!isRecord(payload)) throw new Error(`${operation} returned a non-object response`);
  if (!isRecord(payload.result)) throw new Error(`${operation} response.result must be an object`);
  const entries = payload.result[key];
  if (!Array.isArray(entries)) {
    throw new Error(`${operation} response.result.${key} must be an array`);
  }
  return entries.map((value: unknown, index) => {
    if (!isRecord(value)) throw new Error(`${operation} ${entry} ${index} must be an object`);
    return value;
  });
}

/** The session's workspaces in sidebar order. Read-only. */
export async function listWorkspaces(
  run: CommandRunner,
  target: SessionTarget & Readonly<{ complete?: boolean }>,
): Promise<readonly WorkspaceListing[]> {
  const operation = "herdr workspace list";
  const request = herdrRequest(target.sessionId, target.cwd, ["workspace", "list"]);
  const result = await runChecked(run, request, operation);
  const payload = parseJson(result.stdout, operation);
  if (target.complete !== true) return parseWorkspaceList(payload, operation, result.stdout);
  return completeEntries(payload, "workspaces", "workspace", operation).map((workspace, index) => ({
    workspaceId: completeText(
      workspace.workspace_id,
      `workspace[${index}].workspace_id`,
      operation,
    ),
    activeTabId: completeText(
      workspace.active_tab_id,
      `workspace[${index}].active_tab_id`,
      operation,
    ),
    label: completeText(workspace.label, `workspace[${index}].label`, operation),
  }));
}

export async function orderWorkspaceAfter(
  run: CommandRunner,
  input: SessionTarget &
    Readonly<{ workspaceId: string; parentWorkspaceId: string; insertIndex?: number }>,
  mover: WorkspaceMover | undefined,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const parentWorkspaceId = checkedText(input.parentWorkspaceId, "parentWorkspaceId");
  const workspaceId = checkedText(input.workspaceId, "workspaceId");
  if (parentWorkspaceId === workspaceId) {
    warnings.push("refused workspace.move because parent and created workspace ids are identical");
    return warnings;
  }
  if (
    input.insertIndex !== undefined &&
    (!Number.isSafeInteger(input.insertIndex) || input.insertIndex < 0)
  ) {
    warnings.push("refused workspace.move because insertIndex is not a non-negative integer");
    return warnings;
  }
  let status: HerdrSessionStatus;
  try {
    status = await readHerdrStatus(run, input.sessionId, input.cwd);
  } catch (error) {
    warnings.push(
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  let workspaces: readonly WorkspaceListing[];
  try {
    const request = herdrRequest(input.sessionId, input.cwd, ["workspace", "list"]);
    const result = await runChecked(run, request, "herdr workspace list");
    workspaces = parseWorkspaceList(
      parseJson(result.stdout, "herdr workspace list"),
      "herdr workspace list",
      result.stdout,
    );
  } catch (error) {
    warnings.push(
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  const parentMatches = workspaces.filter(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const targetMatches = workspaces.filter((workspace) => workspace.workspaceId === workspaceId);
  if (parentMatches.length !== 1 || targetMatches.length !== 1) {
    warnings.push(
      `workspace.move skipped because parent (${parentMatches.length}) or target (${targetMatches.length}) identity was ambiguous`,
    );
    return warnings;
  }
  const parentIndex = workspaces.findIndex(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const insertIndex = input.insertIndex ?? parentIndex + 1;
  if (insertIndex > workspaces.length) {
    warnings.push(
      `workspace.move skipped because insertIndex ${insertIndex} is outside the workspace list`,
    );
    return warnings;
  }

  const moveRequest: WorkspaceMoveRequest = {
    socketPath: status.socketPath,
    workspaceId,
    insertIndex,
  };
  try {
    const response = await (mover ?? moveWorkspaceOverSocket)(moveRequest);
    const responseText = JSON.stringify(response) ?? String(response);
    const parsed = parseWorkspaceMoveResponse(response, "herdr workspace.move", responseText);
    const targetCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === workspaceId,
    ).length;
    const parentCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === parentWorkspaceId,
    ).length;
    if (targetCount !== 1 || parentCount !== 1) {
      warnings.push(
        "workspace.move returned an unverifiable workspace identity; no retry was attempted",
      );
    }
  } catch (error) {
    warnings.push(
      `workspace.move failed; worker placement was preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return warnings;
}

/** The workspace's label, or undefined when the workspace or its session is gone. */
export async function workspaceLabel(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ workspaceId: string }>,
): Promise<string | undefined> {
  const request = herdrRequest(input.sessionId, input.cwd, ["workspace", "get", input.workspaceId]);
  const current = await run(request);
  if (current.code !== 0) {
    const code = errorCode(current);
    if (
      code === "workspace_not_found" ||
      code === "session_not_found" ||
      code === "server_not_running"
    )
      return undefined;
    throw new AdapterCommandError("herdr workspace get", request, current);
  }
  const value = parseAnswer(current.stdout, "herdr workspace get");
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    value.result.type !== "workspace_info" ||
    !isRecord(value.result.workspace) ||
    value.result.workspace.workspace_id !== input.workspaceId ||
    typeof value.result.workspace.label !== "string"
  ) {
    throw new Error("Herdr returned an unknown coordinator workspace identity");
  }
  return value.result.workspace.label;
}

export async function renameWorkspace(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ workspaceId: string; label: string }>,
): Promise<void> {
  const { workspaceId, label } = input;
  const request = herdrRequest(input.sessionId, input.cwd, [
    "workspace",
    "rename",
    workspaceId,
    label,
  ]);
  const renamed = await run(request);
  if (renamed.code !== 0) throw new AdapterCommandError("herdr workspace rename", request, renamed);
  const acknowledgement = parseAnswer(renamed.stdout, "herdr workspace rename");
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

export async function listPanes(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ workspaceId?: string; complete?: boolean }>,
): Promise<readonly PaneListing[]> {
  const operation = "herdr pane list";
  const request = herdrRequest(input.sessionId, input.cwd, [
    "pane",
    "list",
    ...(input.workspaceId === undefined ? [] : ["--workspace", input.workspaceId]),
  ]);
  const listed = await run(request);
  if (listed.code !== 0) throw new AdapterCommandError(operation, request, listed);
  const value = parseAnswer(listed.stdout, operation);
  if (input.complete === true) {
    return completeEntries(value, "panes", "pane", operation).map((pane, index) => {
      const foregroundCwd =
        pane.foreground_cwd === undefined
          ? undefined
          : completeText(pane.foreground_cwd, `pane[${index}].foreground_cwd`, operation);
      return {
        paneId: completeText(pane.pane_id, `pane[${index}].pane_id`, operation),
        tabId: completeText(pane.tab_id, `pane[${index}].tab_id`, operation),
        workspaceId: completeText(pane.workspace_id, `pane[${index}].workspace_id`, operation),
        cwd: completeText(pane.cwd, `pane[${index}].cwd`, operation),
        ...(foregroundCwd === undefined ? {} : { foregroundCwd }),
      };
    });
  }
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.panes)) {
    throw new Error("herdr pane list returned an unknown pane list");
  }
  return value.result.panes.flatMap((pane: unknown): PaneListing[] =>
    !isRecord(pane) ||
    typeof pane.workspace_id !== "string" ||
    typeof pane.tab_id !== "string" ||
    typeof pane.pane_id !== "string" ||
    typeof pane.cwd !== "string"
      ? []
      : [
          {
            paneId: pane.pane_id,
            tabId: pane.tab_id,
            workspaceId: pane.workspace_id,
            cwd: pane.cwd,
            ...(typeof pane.foreground_cwd === "string"
              ? { foregroundCwd: pane.foreground_cwd }
              : {}),
          },
        ],
  );
}

function parseSnapshotPanes(value: string): readonly SessionPane[] {
  const root = parseAnswer(value, "herdr api snapshot");
  if (!isRecord(root) || !isRecord(root.result) || root.result.type !== "session_snapshot") {
    throw new Error("herdr api snapshot returned an unknown session snapshot protocol");
  }
  const snapshot = root.result.snapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.panes)) {
    throw new Error("herdr api snapshot omitted the session panes");
  }
  return snapshot.panes.map((value, index) => {
    if (!isRecord(value)) throw new Error(`herdr api snapshot pane ${index} is malformed`);
    const agentStatus =
      value.agent_status === undefined
        ? undefined
        : checkedText(value.agent_status, `snapshot.panes[${index}].agent_status`);
    return {
      workspaceId: checkedText(value.workspace_id, `snapshot.panes[${index}].workspace_id`),
      tabId: checkedText(value.tab_id, `snapshot.panes[${index}].tab_id`),
      paneId: checkedText(value.pane_id, `snapshot.panes[${index}].pane_id`),
      ...(agentStatus === undefined ? {} : { agentStatus }),
    };
  });
}

export async function snapshot(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ allowMissingSession?: boolean }>,
): Promise<readonly SessionPane[]> {
  const request = herdrRequest(input.sessionId, input.cwd, ["api", "snapshot"]);
  const result = await run(request);
  if (result.code !== 0) {
    if (input.allowMissingSession === true && isSessionMissing(result)) return [];
    throw new AdapterCommandError("herdr api snapshot", request, result);
  }
  return parseSnapshotPanes(result.stdout);
}

export async function focusWorkspace(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ workspaceId: string; env?: Readonly<Record<string, string>> }>,
): Promise<FocusResult> {
  const result = await run(
    herdrRequest(input.sessionId, input.cwd, ["workspace", "focus", input.workspaceId], input.env),
  );
  return result.code === 0
    ? { focused: true }
    : { focused: false, code: result.code, detail: result.stderr.trim() || result.stdout.trim() };
}

export async function sessionRunning(run: CommandRunner, target: SessionTarget): Promise<boolean> {
  const status = await readHerdrStatus(run, target.sessionId, target.cwd, true);
  if (status.running === undefined) {
    throw new Error(
      `Herdr session ${JSON.stringify(target.sessionId)} status omitted explicit server.running state`,
    );
  }
  return status.running;
}

export async function sessionDetail(run: CommandRunner, target: SessionTarget): Promise<string> {
  const request = herdrRequest(target.sessionId, target.cwd, ["status", "--json"]);
  const result = await run(request);
  if (result.code !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${request.argv.join(" ")} failed with exit code ${result.code}${details.length === 0 ? "" : `: ${details}`}`,
    );
  }
  return result.stdout.trim() || "session status available";
}
