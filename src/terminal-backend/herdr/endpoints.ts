import { quoteShellCommand } from "../../adapters/commands.ts";
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
} from "../../adapters/primitives.ts";
import {
  type AgentRole,
  type CommandResult,
  type CommandRunner,
  type Endpoint,
  LEGACY_ENDPOINT_ROLES,
} from "../../contracts.ts";
import {
  type EndpointInspection,
  type EndpointTarget,
  type ForegroundProcess,
  isWorkerProcess,
  type PaneIdentity,
  type ProcessInfo,
  type SplitAnchor,
  type TerminalBackend,
  type WorkspaceMover,
} from "../contract.ts";
import { errorCode, herdrRequest, isPaneMissing, isPaneNotFound, parseAnswer } from "./protocol.ts";
import { orderWorkspaceAfter } from "./workspaces.ts";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERRUPT_POLL_MS = 100;

// ponytail: accepts legacy "verifier" too (see LEGACY_ENDPOINT_ROLES) so an existing pane opened
// for that role still passes ownership checks (inspect/pause/interrupt/close) instead of erroring.
function checkedRole(value: unknown): Endpoint["role"] {
  if (typeof value !== "string" || !LEGACY_ENDPOINT_ROLES.includes(value as Endpoint["role"])) {
    throw new TypeError(`role ${JSON.stringify(value)} is unsupported`);
  }
  return value as Endpoint["role"];
}

function validateEndpoint(endpoint: Endpoint): void {
  checkedText(endpoint.sessionId, "sessionId");
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
): PaneIdentity {
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

async function readPaneIdentity(run: CommandRunner, input: EndpointTarget): Promise<PaneIdentity> {
  validateEndpoint(input.endpoint);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    input.endpoint.paneId,
  ]);
  const result = await run(request);
  if (result.code !== 0) {
    if (isPaneNotFound(result)) {
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
): ForegroundProcess {
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
): ProcessInfo {
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

export async function inspect(
  run: CommandRunner,
  input: EndpointTarget,
): Promise<EndpointInspection> {
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
    sessionId: checkedText(sessionId, "sessionId"),
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

type CreateWorkspaceInput = Parameters<TerminalBackend["createWorkspace"]>[0];

export async function createWorkspace(
  run: CommandRunner,
  input: CreateWorkspaceInput,
  mover: WorkspaceMover | undefined,
): Promise<Readonly<{ endpoint: Endpoint; warnings: readonly string[] }>> {
  const label = checkedText(input.label, "workspaceLabel");
  const request = herdrRequest(
    input.sessionId,
    input.cwd,
    ["workspace", "create", "--cwd", checkedPath(input.cwd, "cwd"), "--label", label, "--no-focus"],
    input.env,
  );
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
      : await orderWorkspaceAfter(
          run,
          {
            sessionId: endpoint.sessionId,
            cwd: input.cwd,
            workspaceId: endpoint.workspaceId,
            parentWorkspaceId: input.parentWorkspaceId,
            ...(input.insertIndex === undefined ? {} : { insertIndex: input.insertIndex }),
          },
          mover,
        );
  return { endpoint, warnings };
}

/**
 * Opens a fresh pane beside an anchor. An anchor known only by pane id is read from Herdr first,
 * so the split is proven to land next to it; nothing is ever written to the anchor itself.
 */
export async function splitBeside(
  run: CommandRunner,
  input: SplitAnchor & Readonly<{ cwd: string; role: AgentRole; generation: number }>,
): Promise<Endpoint> {
  if ("anchor" in input) {
    return splitPane(
      run,
      input.anchor,
      input.cwd,
      input.role,
      input.generation,
      "herdr pane split",
    );
  }
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
    sessionId: checkedText(input.sessionId, "sessionId"),
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
  return splitPane(run, anchor, input.cwd, input.role, input.generation, "herdr pane split");
}

export async function runCommand(
  run: CommandRunner,
  input: EndpointTarget &
    Readonly<{ command: readonly string[]; env?: Readonly<Record<string, string>> }>,
): Promise<void> {
  validateEndpoint(input.endpoint);
  if (input.command.length === 0) throw new TypeError("Herdr pane command cannot be empty");
  const request = herdrRequest(
    input.endpoint.sessionId,
    input.cwd,
    ["pane", "run", input.endpoint.paneId, quoteShellCommand(input.command)],
    input.env,
  );
  await runChecked(run, request, "herdr pane run");
}

export async function sendKeys(
  run: CommandRunner,
  input: EndpointTarget & Readonly<{ keys: readonly string[] }>,
): Promise<void> {
  validateEndpoint(input.endpoint);
  await runChecked(
    run,
    herdrRequest(input.endpoint.sessionId, input.cwd, [
      "pane",
      "send-keys",
      input.endpoint.paneId,
      ...input.keys,
    ]),
    "herdr pane graceful exit",
  );
}

function waitMilliseconds(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function interrupt(
  run: CommandRunner,
  input: EndpointTarget & Readonly<{ key?: string; timeoutMs?: number; pollIntervalMs?: number }>,
): Promise<Readonly<{ wasRunning: boolean }>> {
  validateEndpoint(input.endpoint);
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_INTERRUPT_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("timeoutMs must be finite and non-negative");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be finite and non-negative");
  }
  const initial = await inspect(run, { endpoint: input.endpoint, cwd: input.cwd });
  if (!initial.activeWorker) return { wasRunning: false };

  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "send-keys",
    input.endpoint.paneId,
    input.key ?? "ctrl+c",
  ]);
  await runChecked(run, request, "herdr pane interrupt");

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspection = await inspect(run, { endpoint: input.endpoint, cwd: input.cwd });
    if (!inspection.activeWorker) return { wasRunning: true };
    if (Date.now() >= deadline) {
      throw new EndpointBusyError(input.endpoint);
    }
    await waitMilliseconds(pollIntervalMs);
  }
}

async function verifyPaneClosed(run: CommandRunner, input: EndpointTarget): Promise<void> {
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
  if (!isPaneNotFound(result)) {
    throw new AdapterCommandError("herdr pane close verification", request, result);
  }
}

export async function close(
  run: CommandRunner,
  input: EndpointTarget & Readonly<{ force?: boolean }>,
): Promise<void> {
  let inspection: EndpointInspection;
  try {
    inspection = await inspect(run, { endpoint: input.endpoint, cwd: input.cwd });
  } catch (error) {
    if (
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      (error instanceof AdapterCommandError && isPaneNotFound(error.result))
    ) {
      return;
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
}

function isAcknowledged(result: CommandResult): boolean {
  const output = result.stdout.trim();
  if (output.length === 0) return false;
  const value = parseAnswer(output, "herdr pane close");
  return isRecord(value) && isRecord(value.result) && value.result.type === "ok";
}

export async function closeOwned(
  run: CommandRunner,
  input: EndpointTarget & Readonly<{ strictProof?: boolean }>,
): Promise<void> {
  const { endpoint } = input;
  const request = herdrRequest(endpoint.sessionId, input.cwd, ["pane", "close", endpoint.paneId]);
  const result = await run(request);
  if (result.code !== 0) throw new AdapterCommandError("herdr pane close", request, result);
  if (!isAcknowledged(result))
    throw new Error("herdr pane close returned an unknown acknowledgement");
  const verifyRequest = herdrRequest(endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    endpoint.paneId,
  ]);
  const verification = await run(verifyRequest);
  if (verification.code === 0) {
    throw new Error(
      `Herdr pane close returned success but pane ${JSON.stringify(endpoint.paneId)} remains present`,
    );
  }
  const gone =
    input.strictProof === true
      ? errorCode(verification) === "pane_not_found"
      : isPaneMissing(verification);
  if (!gone) {
    throw new AdapterCommandError("herdr pane close verification", verifyRequest, verification);
  }
}

export async function promptAgent(
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
