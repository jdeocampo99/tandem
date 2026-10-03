import { realpath as defaultRealpath } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  type AgentRole,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type Endpoint,
  LEGACY_ENDPOINT_ROLES,
} from "../contracts.ts";
import { type WorkerTerminalJob, workerDelegationStopped } from "../workers/terminal.ts";
import { quoteShellCommand } from "./commands.ts";
import {
  AdapterCommandError,
  AdapterError,
  AdapterProtocolError,
  checkedGeneration,
  checkedPath,
  checkedText,
  EndpointBusyError,
  EndpointOwnershipError,
  isRecord,
  optionalInteger,
  optionalString,
  parseJson,
  requiredInteger,
  requiredRecord,
  requiredString,
  runChecked,
  type WorktreeAdapterOptions,
} from "./primitives.ts";

const SHELL_PROCESS_NAMES: Readonly<Record<string, true>> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  fish: true,
};
const SOCKET_RESPONSE_LIMIT = 4 * 1024 * 1024;
const MAX_TASK_WORKSPACE_TITLE_LENGTH = 32;
const workspaceGraphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

function normalizeWorkspaceText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateWorkspaceText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "…";
  const available = Math.max(0, maxLength - suffix.length);
  let output = "";
  for (const segment of workspaceGraphemes.segment(value)) {
    if (output.length + segment.segment.length > available) break;
    output += segment.segment;
  }
  return `${output}${suffix}`;
}
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERRUPT_POLL_MS = 100;
type HerdrPaneIdentity = Readonly<{
  paneId: string;
  tabId: string;
  workspaceId: string;
  foregroundCwd: string | undefined;
}>;
export type HerdrWorkspace = Readonly<{ workspaceId: string; label?: string }>;
export type HerdrSessionStatus = Readonly<{ socketPath: string; running: boolean | undefined }>;
type HerdrWorkspaceMoveResponse = Readonly<{
  type: "workspace_list";
  workspaces: readonly HerdrWorkspace[];
}>;
export type HerdrAdapterOptions = Readonly<{
  moveWorkspace?: (request: HerdrWorkspaceMoveRequest) => Promise<unknown>;
  warn?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>;

export type HerdrWorkspaceMoveRequest = Readonly<{
  socketPath: string;
  workspaceId: string;
  insertIndex: number;
}>;
export type HerdrWorkspaceOrderInput = Readonly<{
  sessionId: string;
  cwd: string;
  workspaceId: string;
  parentWorkspaceId: string;
  insertIndex?: number;
}>;

export type CreateTaskEndpointInput = Readonly<{
  sessionId: string;
  cwd: string;
  taskName: string;
  workspaceLabel: string;
  role: AgentRole;
  generation: number;
  parentWorkspaceId?: string;
  insertIndex?: number;
}>;

export type CreateReviewerEndpointInput = Readonly<{
  sessionId: string;
  cwd: string;
  writer: Endpoint;
  generation: number;
  writerJob?: WorkerTerminalJob;
}>;

export type HerdrEndpointResult = Readonly<{
  endpoint: Endpoint;
  warnings: readonly string[];
}>;

export type InspectEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
}>;

export type HerdrForegroundProcess = Readonly<{
  pid: number;
  name: string;
  argv: readonly string[];
  argv0: string | undefined;
  commandLine: string | undefined;
}>;

export type HerdrProcessInfo = Readonly<{
  paneId: string;
  shellPid: number | undefined;
  foregroundProcessGroupId: number | undefined;
  foregroundProcesses: readonly HerdrForegroundProcess[];
}>;

export type HerdrPaneInspection = Readonly<{
  endpoint: Endpoint;
  pane: HerdrPaneIdentity;
  processInfo: HerdrProcessInfo;
  activeWorker: boolean;
}>;

export type SendCommandInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  command: readonly string[];
}>;

export type HerdrCommandResult = Readonly<{
  endpoint: Endpoint;
  command: readonly string[];
  result: CommandResult;
}>;

export type InterruptEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  /** The key that stops the foreground program; `ctrl+c` unless the program quits another way. */
  key?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>;

export type InterruptEndpointResult = Readonly<{
  endpoint: Endpoint;
  wasRunning: boolean;
  stopped: true;
}>;

export type CloseEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  /** The user approved discarding the pane's work, so a still-running process closes with it. */
  force?: boolean;
}>;

export type CloseEndpointResult = Readonly<{
  endpoint: Endpoint;
  closed: true;
}>;
// ponytail: accepts legacy "verifier" too (see LEGACY_ENDPOINT_ROLES) so an existing pane opened
// for that role still passes ownership checks (inspect/pause/interrupt/close) instead of erroring.
function checkedRole(value: unknown): Endpoint["role"] {
  if (typeof value !== "string" || !LEGACY_ENDPOINT_ROLES.includes(value as Endpoint["role"])) {
    throw new TypeError(`role ${JSON.stringify(value)} is unsupported`);
  }
  return value as Endpoint["role"];
}

function checkedSession(value: string): string {
  return checkedText(value, "sessionId");
}

function herdrRequest(sessionId: string, cwd: string, args: readonly string[]): CommandRequest {
  return {
    argv: ["herdr", "--session", checkedSession(sessionId), ...args],
    cwd: checkedPath(cwd, "cwd"),
  };
}
function validateEndpoint(endpoint: Endpoint): void {
  checkedSession(endpoint.sessionId);
  checkedText(endpoint.workspaceId, "endpoint.workspaceId");
  checkedText(endpoint.tabId, "endpoint.tabId");
  checkedText(endpoint.paneId, "endpoint.paneId");
  checkedRole(endpoint.role);
  checkedGeneration(endpoint.generation, "endpoint.generation");
}

function readPaneIdentityFromPayload(
  payload: unknown,
  endpoint: Endpoint,
  operation: string,
  response: string,
): HerdrPaneIdentity {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const pane = requiredRecord(result.pane, "result.pane", operation, response);
  const paneId = requiredString(pane.pane_id, "result.pane.pane_id", operation, response);
  const tabId = requiredString(pane.tab_id, "result.pane.tab_id", operation, response);
  const workspaceId = requiredString(
    pane.workspace_id,
    "result.pane.workspace_id",
    operation,
    response,
  );
  const foregroundCwd = optionalString(
    pane.foreground_cwd,
    "result.pane.foreground_cwd",
    operation,
    response,
  );
  if (
    paneId !== endpoint.paneId ||
    tabId !== endpoint.tabId ||
    workspaceId !== endpoint.workspaceId
  ) {
    throw new EndpointOwnershipError(
      endpoint,
      `Herdr returned pane=${JSON.stringify(paneId)}, tab=${JSON.stringify(tabId)}, workspace=${JSON.stringify(workspaceId)}`,
    );
  }
  return { paneId, tabId, workspaceId, foregroundCwd };
}

async function readPaneIdentity(
  run: CommandRunner,
  input: InspectEndpointInput,
): Promise<HerdrPaneIdentity> {
  validateEndpoint(input.endpoint);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    input.endpoint.paneId,
  ]);
  const result = await run(request);
  if (result.code !== 0) {
    if (isMissingPaneResponse(result)) {
      throw new EndpointOwnershipError(
        input.endpoint,
        "pane is no longer present in the recorded session",
        "missing",
      );
    }
    throw new AdapterCommandError("herdr pane get", request, result);
  }
  return readPaneIdentityFromPayload(
    parseJson(result.stdout, "herdr pane get"),
    input.endpoint,
    "herdr pane get",
    result.stdout,
  );
}

function readProcess(
  value: unknown,
  index: number,
  operation: string,
  response: string,
): HerdrForegroundProcess {
  const process = requiredRecord(value, `foreground_processes[${index}]`, operation, response);
  const pid = requiredInteger(
    process.pid,
    `foreground_processes[${index}].pid`,
    operation,
    response,
  );
  if (pid < 1) {
    throw new AdapterProtocolError(
      operation,
      `foreground_processes[${index}].pid must be positive`,
      response,
    );
  }
  const name = requiredString(
    process.name,
    `foreground_processes[${index}].name`,
    operation,
    response,
  );
  const argvValue = process.argv;
  const argv: string[] = [];
  if (argvValue !== undefined) {
    if (!Array.isArray(argvValue)) {
      throw new AdapterProtocolError(
        operation,
        `foreground_processes[${index}].argv must be an array of strings`,
        response,
      );
    }
    for (const entry of argvValue) {
      if (typeof entry !== "string") {
        throw new AdapterProtocolError(
          operation,
          `foreground_processes[${index}].argv must be an array of strings`,
          response,
        );
      }
      argv.push(entry);
    }
  }
  const argv0 = optionalString(
    process.argv0,
    `foreground_processes[${index}].argv0`,
    operation,
    response,
  );
  const commandLine = optionalString(
    process.cmdline ?? process.command,
    `foreground_processes[${index}].cmdline`,
    operation,
    response,
  );
  return { pid, name, argv, argv0, commandLine };
}

function readProcessInfo(
  payload: unknown,
  endpoint: Endpoint,
  operation: string,
  response: string,
): HerdrProcessInfo {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const processInfo = requiredRecord(
    result.process_info,
    "result.process_info",
    operation,
    response,
  );
  const paneId = requiredString(
    processInfo.pane_id,
    "result.process_info.pane_id",
    operation,
    response,
  );
  if (paneId !== endpoint.paneId) {
    throw new EndpointOwnershipError(
      endpoint,
      `process-info described pane ${JSON.stringify(paneId)} instead of ${JSON.stringify(endpoint.paneId)}`,
    );
  }
  // Herdr omits this optional array when no foreground processes are reported.
  const processes =
    processInfo.foreground_processes === undefined ? [] : processInfo.foreground_processes;
  if (!Array.isArray(processes)) {
    throw new AdapterProtocolError(operation, "foreground_processes must be an array", response);
  }
  const foregroundProcesses = processes.map((entry, index) =>
    readProcess(entry, index, operation, response),
  );
  const shellPid = optionalInteger(
    processInfo.shell_pid,
    "result.process_info.shell_pid",
    operation,
    response,
  );
  const foregroundProcessGroupId = optionalInteger(
    processInfo.foreground_process_group_id,
    "result.process_info.foreground_process_group_id",
    operation,
    response,
  );
  return { paneId, shellPid, foregroundProcessGroupId, foregroundProcesses };
}

function processBasename(value: string): string {
  const withoutPath = value.split("/").at(-1) ?? value;
  return withoutPath.replace(/^-/, "").toLowerCase();
}

export function isWorkerProcess(process: HerdrForegroundProcess): boolean {
  const name = processBasename(process.name);
  const argv0 = process.argv0 === undefined ? undefined : processBasename(process.argv0);
  return (
    SHELL_PROCESS_NAMES[name] !== true ||
    (argv0 !== undefined && SHELL_PROCESS_NAMES[argv0] !== true)
  );
}

export async function inspectEndpoint(
  run: CommandRunner,
  input: InspectEndpointInput,
): Promise<HerdrPaneInspection> {
  validateEndpoint(input.endpoint);
  const pane = await readPaneIdentity(run, input);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "process-info",
    "--pane",
    input.endpoint.paneId,
  ]);
  const result = await runChecked(run, request, "herdr pane process-info");
  const processInfo = readProcessInfo(
    parseJson(result.stdout, "herdr pane process-info"),
    input.endpoint,
    "herdr pane process-info",
    result.stdout,
  );
  return {
    endpoint: input.endpoint,
    pane,
    processInfo,
    activeWorker: processInfo.foregroundProcesses.some((process) => isWorkerProcess(process)),
  };
}
export async function inspectStopped(
  run: CommandRunner,
  endpoint: Endpoint,
  cwd: string,
): Promise<boolean> {
  const inspection = await inspectEndpoint(run, { endpoint, cwd });
  return !inspection.activeWorker;
}

function parseWorkspaceList(
  payload: unknown,
  operation: string,
  response: string,
): readonly HerdrWorkspace[] {
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
    return {
      workspaceId: requiredString(
        workspace.workspace_id,
        `result.workspaces[${index}].workspace_id`,
        operation,
        response,
      ),
      ...(label === undefined ? {} : { label }),
    };
  });
}

function parseCreatedEndpoint(
  payload: unknown,
  sessionId: string,
  role: AgentRole,
  generation: number,
  operation: string,
  response: string,
): Endpoint {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const workspace = requiredRecord(result.workspace, "result.workspace", operation, response);
  const tab = requiredRecord(result.tab, "result.tab", operation, response);
  const rootPane = requiredRecord(result.root_pane, "result.root_pane", operation, response);
  const workspaceId = requiredString(
    workspace.workspace_id,
    "result.workspace.workspace_id",
    operation,
    response,
  );
  const tabId = requiredString(tab.tab_id, "result.tab.tab_id", operation, response);
  const paneId = requiredString(rootPane.pane_id, "result.root_pane.pane_id", operation, response);
  return {
    sessionId: checkedSession(sessionId),
    workspaceId,
    tabId,
    paneId,
    role: checkedRole(role),
    generation: checkedGeneration(generation),
  };
}

function parseSplitEndpoint(
  payload: unknown,
  anchor: Endpoint,
  role: AgentRole,
  generation: number,
  operation: string,
  response: string,
): Endpoint {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const pane = requiredRecord(result.pane, "result.pane", operation, response);
  const workspaceId = requiredString(
    pane.workspace_id,
    "result.pane.workspace_id",
    operation,
    response,
  );
  const tabId = requiredString(pane.tab_id, "result.pane.tab_id", operation, response);
  const paneId = requiredString(pane.pane_id, "result.pane.pane_id", operation, response);
  if (workspaceId !== anchor.workspaceId || tabId !== anchor.tabId) {
    throw new EndpointOwnershipError(
      anchor,
      `${operation} landed in workspace ${JSON.stringify(workspaceId)}, tab ${JSON.stringify(tabId)} instead of workspace ${JSON.stringify(anchor.workspaceId)}, tab ${JSON.stringify(anchor.tabId)}`,
    );
  }
  if (paneId === anchor.paneId) {
    throw new AdapterProtocolError(operation, "split reused the anchor pane id", response);
  }
  return {
    sessionId: anchor.sessionId,
    workspaceId,
    tabId,
    paneId,
    role: checkedRole(role),
    generation: checkedGeneration(generation),
  };
}

/** Opens a new, unfocused pane to the right of `anchor`, proven to share its workspace and tab. */
async function splitPane(
  run: CommandRunner,
  anchor: Endpoint,
  cwd: string,
  role: AgentRole,
  generation: number,
  operation: string,
): Promise<Endpoint> {
  const request = herdrRequest(anchor.sessionId, cwd, [
    "pane",
    "split",
    anchor.paneId,
    "--direction",
    "right",
    "--cwd",
    checkedPath(cwd, "cwd"),
    "--no-focus",
  ]);
  const result = await runChecked(run, request, operation);
  return parseSplitEndpoint(
    parseJson(result.stdout, operation),
    anchor,
    role,
    generation,
    operation,
    result.stdout,
  );
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

export async function readHerdrStatus(
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

function recordWarning(options: HerdrAdapterOptions, warnings: string[], message: string): void {
  warnings.push(message);
  options.warn?.(message);
}

async function moveWorkspaceOverSocket(request: HerdrWorkspaceMoveRequest): Promise<unknown> {
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
function waitMilliseconds(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
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

/**
 * Shows a notification through the user's Herdr toast settings (in-app, system, terminal, or off),
 * with Herdr's needs-input sound.
 */
export async function showNotification(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  notice: Readonly<{ readonly title: string; readonly body: string }>,
): Promise<void> {
  const args = ["notification", "show", notice.title, "--body", notice.body, "--sound", "request"];
  await runChecked(run, herdrRequest(sessionId, cwd, args), "herdr notification show");
}

/** The session's workspaces with their labels, in sidebar order. Read-only. */
export async function listWorkspaces(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
): Promise<readonly HerdrWorkspace[]> {
  const request = herdrRequest(sessionId, cwd, ["workspace", "list"]);
  const result = await runChecked(run, request, "herdr workspace list");
  return parseWorkspaceList(
    parseJson(result.stdout, "herdr workspace list"),
    "herdr workspace list",
    result.stdout,
  );
}

export async function moveWorkspaceAfterParent(
  run: CommandRunner,
  input: HerdrWorkspaceOrderInput,
  options: HerdrAdapterOptions = {},
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const parentWorkspaceId = checkedText(input.parentWorkspaceId, "parentWorkspaceId");
  const workspaceId = checkedText(input.workspaceId, "workspaceId");
  if (parentWorkspaceId === workspaceId) {
    recordWarning(
      options,
      warnings,
      "refused workspace.move because parent and created workspace ids are identical",
    );
    return warnings;
  }
  if (
    input.insertIndex !== undefined &&
    (!Number.isSafeInteger(input.insertIndex) || input.insertIndex < 0)
  ) {
    recordWarning(
      options,
      warnings,
      "refused workspace.move because insertIndex is not a non-negative integer",
    );
    return warnings;
  }
  let status: HerdrSessionStatus;
  try {
    status = await readHerdrStatus(run, input.sessionId, input.cwd);
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  let workspaces: readonly HerdrWorkspace[];
  try {
    const request = herdrRequest(input.sessionId, input.cwd, ["workspace", "list"]);
    const result = await runChecked(run, request, "herdr workspace list");
    workspaces = parseWorkspaceList(
      parseJson(result.stdout, "herdr workspace list"),
      "herdr workspace list",
      result.stdout,
    );
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  const parentMatches = workspaces.filter(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const targetMatches = workspaces.filter((workspace) => workspace.workspaceId === workspaceId);
  if (parentMatches.length !== 1 || targetMatches.length !== 1) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped because parent (${parentMatches.length}) or target (${targetMatches.length}) identity was ambiguous`,
    );
    return warnings;
  }
  const parentIndex = workspaces.findIndex(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const insertIndex = input.insertIndex ?? parentIndex + 1;
  if (insertIndex > workspaces.length) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped because insertIndex ${insertIndex} is outside the workspace list`,
    );
    return warnings;
  }

  const moveRequest: HerdrWorkspaceMoveRequest = {
    socketPath: status.socketPath,
    workspaceId,
    insertIndex,
  };
  try {
    const response = await (options.moveWorkspace ?? moveWorkspaceOverSocket)(moveRequest);
    const responseText = JSON.stringify(response) ?? String(response);
    const parsed = parseWorkspaceMoveResponse(response, "herdr workspace.move", responseText);
    const targetCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === workspaceId,
    ).length;
    const parentCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === parentWorkspaceId,
    ).length;
    if (targetCount !== 1 || parentCount !== 1) {
      recordWarning(
        options,
        warnings,
        "workspace.move returned an unverifiable workspace identity; no retry was attempted",
      );
    }
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move failed; worker placement was preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return warnings;
}

/** Names a task's sidebar workspace by its short title, or by its objective on older tasks. */
export function taskWorkspaceLabel(task: Readonly<{ title?: string; objective: string }>): string {
  const title = normalizeWorkspaceText(task.title ?? "");
  const name = title.length === 0 ? normalizeWorkspaceText(task.objective) : title;
  if (name.length === 0) throw new TypeError("task title or objective must be non-empty text");
  return `└ ${truncateWorkspaceText(name, MAX_TASK_WORKSPACE_TITLE_LENGTH)}`;
}

export async function createTaskEndpoint(
  run: CommandRunner,
  input: CreateTaskEndpointInput,
  options: HerdrAdapterOptions = {},
): Promise<HerdrEndpointResult> {
  const label = checkedText(input.workspaceLabel, "workspaceLabel");
  const request = herdrRequest(input.sessionId, input.cwd, [
    "workspace",
    "create",
    "--cwd",
    checkedPath(input.cwd, "cwd"),
    "--label",
    label,
    "--no-focus",
  ]);
  const result = await runChecked(run, request, "herdr workspace create");
  const endpoint = parseCreatedEndpoint(
    parseJson(result.stdout, "herdr workspace create"),
    input.sessionId,
    input.role,
    input.generation,
    "herdr workspace create",
    result.stdout,
  );
  const warnings =
    input.parentWorkspaceId === undefined
      ? []
      : await moveWorkspaceAfterParent(
          run,
          {
            sessionId: endpoint.sessionId,
            cwd: input.cwd,
            workspaceId: endpoint.workspaceId,
            parentWorkspaceId: input.parentWorkspaceId,
            ...(input.insertIndex === undefined ? {} : { insertIndex: input.insertIndex }),
          },
          options,
        );
  return { endpoint, warnings };
}

export async function createReviewerEndpoint(
  run: CommandRunner,
  input: CreateReviewerEndpointInput,
  options: WorktreeAdapterOptions = {},
): Promise<HerdrEndpointResult> {
  validateEndpoint(input.writer);
  if (input.sessionId !== input.writer.sessionId) {
    throw new EndpointOwnershipError(
      input.writer,
      "reviewer session does not match writer session",
    );
  }
  const writerInspection = await inspectEndpoint(run, { endpoint: input.writer, cwd: input.cwd });
  const writerStopped =
    input.writerJob === undefined
      ? !writerInspection.activeWorker
      : await workerDelegationStopped(writerInspection, input.writerJob);
  if (!writerStopped) throw new EndpointBusyError(input.writer);
  const writerPane = writerInspection.pane;
  if (writerPane.foregroundCwd === undefined) {
    throw new EndpointOwnershipError(input.writer, "writer working directory is unavailable");
  }
  const resolvePhysicalPath = options.realpath ?? defaultRealpath;
  const [writerDirectory, reviewerDirectory] = await Promise.all([
    resolvePhysicalPath(writerPane.foregroundCwd),
    resolvePhysicalPath(checkedPath(input.cwd, "cwd")),
  ]);
  if (writerDirectory !== reviewerDirectory) {
    throw new EndpointOwnershipError(
      input.writer,
      `writer cwd ${JSON.stringify(writerPane.foregroundCwd)} does not match reviewer cwd ${JSON.stringify(input.cwd)}`,
    );
  }
  const endpoint = await splitPane(
    run,
    input.writer,
    input.cwd,
    "reviewer",
    input.generation,
    "herdr reviewer pane split",
  );
  return { endpoint, warnings: [] };
}

export type SplitBesidePaneInput = Readonly<{
  sessionId: string;
  cwd: string;
  /** The existing pane to split; the new pane lands beside it in the same workspace and tab. */
  anchorPaneId: string;
  role: AgentRole;
  generation: number;
}>;

/**
 * Opens a fresh pane beside an existing one. The anchor's workspace and tab are read from Herdr
 * first so the split is proven to land next to it; nothing is ever written to the anchor itself.
 */
export async function splitBesidePane(
  run: CommandRunner,
  input: SplitBesidePaneInput,
): Promise<HerdrEndpointResult> {
  const operation = "herdr anchor pane get";
  const anchorPaneId = checkedText(input.anchorPaneId, "anchorPaneId");
  const request = herdrRequest(input.sessionId, input.cwd, ["pane", "get", anchorPaneId]);
  const result = await runChecked(run, request, operation);
  const root = requiredRecord(
    parseJson(result.stdout, operation),
    "response",
    operation,
    result.stdout,
  );
  const payload = requiredRecord(root.result, "result", operation, result.stdout);
  const pane = requiredRecord(payload.pane, "result.pane", operation, result.stdout);
  const anchor: Endpoint = {
    sessionId: checkedSession(input.sessionId),
    workspaceId: requiredString(
      pane.workspace_id,
      "result.pane.workspace_id",
      operation,
      result.stdout,
    ),
    tabId: requiredString(pane.tab_id, "result.pane.tab_id", operation, result.stdout),
    paneId: requiredString(pane.pane_id, "result.pane.pane_id", operation, result.stdout),
    role: checkedRole(input.role),
    generation: checkedGeneration(input.generation),
  };
  if (anchor.paneId !== anchorPaneId) {
    throw new EndpointOwnershipError(
      anchor,
      `Herdr described pane ${JSON.stringify(anchor.paneId)} instead of anchor ${JSON.stringify(anchorPaneId)}`,
    );
  }
  const endpoint = await splitPane(
    run,
    anchor,
    input.cwd,
    input.role,
    input.generation,
    "herdr pane split",
  );
  return { endpoint, warnings: [] };
}

export async function sendCommand(
  run: CommandRunner,
  input: SendCommandInput,
): Promise<HerdrCommandResult> {
  validateEndpoint(input.endpoint);
  if (input.command.length === 0) throw new TypeError("Herdr pane command cannot be empty");
  await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  const commandText = quoteShellCommand(input.command);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "run",
    input.endpoint.paneId,
    commandText,
  ]);
  const result = await runChecked(run, request, "herdr pane run");
  return { endpoint: input.endpoint, command: input.command, result };
}

/** Sends the agent's exit keys, in one burst, to an idle agent's pane. */
export async function sendExitKeys(
  run: CommandRunner,
  input: CloseEndpointInput,
  keys: readonly string[],
): Promise<void> {
  validateEndpoint(input.endpoint);
  await runChecked(
    run,
    herdrRequest(input.endpoint.sessionId, input.cwd, [
      "pane",
      "send-keys",
      input.endpoint.paneId,
      ...keys,
    ]),
    "herdr pane graceful exit",
  );
}

export async function interruptEndpoint(
  run: CommandRunner,
  input: InterruptEndpointInput,
  options: HerdrAdapterOptions = {},
): Promise<InterruptEndpointResult> {
  validateEndpoint(input.endpoint);
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_INTERRUPT_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("timeoutMs must be finite and non-negative");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be finite and non-negative");
  }
  const initial = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  if (!initial.activeWorker) return { endpoint: input.endpoint, wasRunning: false, stopped: true };

  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "send-keys",
    input.endpoint.paneId,
    input.key ?? "ctrl+c",
  ]);
  await runChecked(run, request, "herdr pane interrupt");

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? waitMilliseconds;
  const deadline = now() + timeoutMs;
  while (true) {
    const inspection = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
    if (!inspection.activeWorker)
      return { endpoint: input.endpoint, wasRunning: true, stopped: true };
    if (now() >= deadline) {
      throw new EndpointBusyError(input.endpoint);
    }
    await sleep(pollIntervalMs);
  }
}

function isMissingPaneResponse(result: CommandResult): boolean {
  if (result.code === 0) return false;
  try {
    const payload: unknown = JSON.parse(result.stderr);
    return isRecord(payload) && isRecord(payload.error) && payload.error.code === "pane_not_found";
  } catch {
    return false;
  }
}

async function verifyPaneClosed(run: CommandRunner, input: CloseEndpointInput): Promise<void> {
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    input.endpoint.paneId,
  ]);
  const result = await run(request);
  if (result.code === 0) {
    readPaneIdentityFromPayload(
      parseJson(result.stdout, "herdr pane close verification"),
      input.endpoint,
      "herdr pane close verification",
      result.stdout,
    );
    throw new AdapterError(
      "Herdr pane close returned success but the exact pane remains present",
      "herdr pane close",
    );
  }
  if (!isMissingPaneResponse(result)) {
    throw new AdapterCommandError("herdr pane close verification", request, result);
  }
}

export async function closeEndpoint(
  run: CommandRunner,
  input: CloseEndpointInput,
): Promise<CloseEndpointResult> {
  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  } catch (error) {
    if (
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      (error instanceof AdapterCommandError && isMissingPaneResponse(error.result))
    ) {
      return { endpoint: input.endpoint, closed: true };
    }
    throw error;
  }
  if (inspection.activeWorker && input.force !== true) throw new EndpointBusyError(input.endpoint);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "close",
    input.endpoint.paneId,
  ]);
  await runChecked(run, request, "herdr pane close");
  await verifyPaneClosed(run, input);
  return { endpoint: input.endpoint, closed: true };
}

/** The Herdr plugin Tandem ships (`herdr-plugin/`), and its welcome popup entrypoint. */
export const TANDEM_HERDR_PLUGIN = "tandem.ui";
export const WELCOME_ENTRYPOINT = "welcome";
/** How the welcome popup learns which pane to prompt: a popup has no `HERDR_PANE_ID`. */
export const WELCOME_PANE_VARIABLE = "TANDEM_WELCOME_PANE";

/** Opens the welcome popup over the session; it prompts `paneId` when the user presses Enter. */
export async function openWelcomePopup(
  run: CommandRunner,
  input: Readonly<{ readonly sessionId: string; readonly cwd: string; readonly paneId: string }>,
): Promise<void> {
  const paneId = checkedText(input.paneId, "paneId");
  await runChecked(
    run,
    herdrRequest(input.sessionId, input.cwd, [
      "plugin",
      "pane",
      "open",
      "--plugin",
      TANDEM_HERDR_PLUGIN,
      "--entrypoint",
      WELCOME_ENTRYPOINT,
      "--env",
      `${WELCOME_PANE_VARIABLE}=${paneId}`,
    ]),
    "herdr plugin pane open",
  );
}

/**
 * Submits a prompt to the agent in a pane. When Herdr does not see an agent there, types the text
 * and presses Enter instead.
 */
export async function promptPane(
  run: CommandRunner,
  input: Readonly<{
    readonly sessionId: string;
    readonly cwd: string;
    readonly paneId: string;
    readonly text: string;
  }>,
): Promise<void> {
  const paneId = checkedText(input.paneId, "paneId");
  const prompted = await run(
    herdrRequest(input.sessionId, input.cwd, ["agent", "prompt", paneId, input.text]),
  );
  if (prompted.code === 0) return;
  await runChecked(
    run,
    herdrRequest(input.sessionId, input.cwd, ["pane", "send-text", paneId, input.text]),
    "herdr pane send-text",
  );
  await runChecked(
    run,
    herdrRequest(input.sessionId, input.cwd, ["pane", "send-keys", paneId, "enter"]),
    "herdr pane send-keys",
  );
}
