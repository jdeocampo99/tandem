import type { CommandRequest, CommandRunner } from "../contracts.ts";
import { AdapterCommandError, AdapterProtocolError, checkedPath } from "./primitives.ts";

export type PresentationPollOptions = Readonly<{
  readonly timeoutMs: number;
  readonly commandTimeoutMs: number;
}>;

const DEFAULT_PRESENTATION_POLL_OPTIONS: PresentationPollOptions = {
  timeoutMs: 1_000,
  commandTimeoutMs: 5_000,
};

export type PresentationStatus =
  | "feedback"
  | "ended"
  | "waiting"
  | "missing"
  | "unknown"
  | "error"
  | "browser_disconnected"
  | "opened"
  | "ready"
  | "user-ended";

const PRESENTATION_STATUSES: Readonly<Record<string, true>> = {
  feedback: true,
  ended: true,
  waiting: true,
  missing: true,
  unknown: true,
  error: true,
  browser_disconnected: true,
  opened: true,
  ready: true,
  "user-ended": true,
};

function isPresentationStatus(value: string): value is PresentationStatus {
  return PRESENTATION_STATUSES[value] === true;
}

export type PresentationObservation = Readonly<{
  artifact: string;
  status: PresentationStatus;
  terminal: boolean;
  sessionEnded: boolean;
  sessionUrl?: string;
  raw: string;
  rawFeedback: string;
}>;

function sessionUrl(value: string): string | undefined {
  const candidate = value.trim().replace(/^(['"])(.*)\1$/u, "$2");
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function extractSessionFields(
  raw: string,
): Readonly<{ status: PresentationStatus; sessionEnded: boolean; sessionUrl?: string }> {
  const lines = raw.split(/\r?\n/u);
  const sessionStart = lines.indexOf("session:");
  if (sessionStart >= 0) {
    let status: PresentationStatus | undefined;
    let sessionEnded = false;
    let sessionUrlValue: string | undefined;
    for (let index = sessionStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || (line.length !== 0 && !/^\s/u.test(line))) break;
      const statusMatch = line.match(/^\s+status:\s*([A-Za-z_-]+)\s*$/u);
      const statusText = statusMatch?.[1];
      if (statusText !== undefined) {
        const candidate = statusText.toLowerCase();
        if (!isPresentationStatus(candidate)) {
          throw new AdapterProtocolError(
            "lavish presentation",
            `unknown session status ${candidate}`,
            raw,
          );
        }
        status = candidate;
      }
      const endedMatch = line.match(/^\s+session_ended:\s*(true|false)\s*$/iu);
      const endedText = endedMatch?.[1];
      if (endedText !== undefined) sessionEnded = endedText.toLowerCase() === "true";
      const urlMatch = line.match(
        /^\s+(?:url|session_url|sessionUrl|browser_url|browserUrl|editor_url|editorUrl):\s*(\S+)\s*$/u,
      );
      const urlText = urlMatch?.[1];
      if (sessionUrlValue === undefined && urlText !== undefined) {
        sessionUrlValue = sessionUrl(urlText);
      }
    }
    if (status === undefined) {
      throw new AdapterProtocolError("lavish presentation", "session block omitted status", raw);
    }
    return {
      status,
      sessionEnded,
      ...(sessionUrlValue === undefined ? {} : { sessionUrl: sessionUrlValue }),
    };
  }
  const firstLine = lines[0] ?? "";
  if (firstLine.startsWith("error:")) {
    const message = firstLine.slice("error:".length).trim();
    const codeLine = lines.find((line, index) => index > 0 && /^code:\s*[A-Z_]+\s*$/u.test(line));
    const code = codeLine === undefined ? "" : codeLine.slice("code:".length).trim();
    if (code === "NOT_FOUND" || message.startsWith("No active Lavish Editor session")) {
      return { status: "missing", sessionEnded: false };
    }
    return { status: "error", sessionEnded: false };
  }
  throw new AdapterProtocolError(
    "lavish presentation",
    "response omitted a textual session or error envelope",
    raw,
  );
}

function extractRawFeedback(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !/^(feedback|prompts)\[\d+\]\{[^}]*\}:\s*$/u.test(line)) {
      index += 1;
      continue;
    }
    const block = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || (next.length !== 0 && !/^\s/u.test(next))) break;
      block.push(next);
      index += 1;
    }
    blocks.push(block.join("\n"));
  }
  return blocks.join("\n");
}

function parsePresentationObservation(artifact: string, raw: string): PresentationObservation {
  const fields = extractSessionFields(raw);
  const terminal = fields.status === "ended" || fields.status === "missing" || fields.sessionEnded;
  return {
    artifact,
    status: fields.status,
    terminal,
    sessionEnded: fields.sessionEnded,
    ...(fields.sessionUrl === undefined ? {} : { sessionUrl: fields.sessionUrl }),
    raw,
    rawFeedback: extractRawFeedback(raw),
  };
}

async function runPresentation(
  run: CommandRunner,
  artifact: string,
  argv: readonly string[],
  cwd: string,
  operation: string,
  options: Readonly<{ readonly commandTimeoutMs?: number }> = {},
): Promise<PresentationObservation> {
  const checkedArtifact = checkedPath(artifact, "artifact");
  const request: CommandRequest = {
    argv,
    cwd: checkedPath(cwd, "cwd"),
    ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
  };
  const result = await run(request);
  const raw = result.stdout.length === 0 ? result.stderr : result.stdout;
  if (raw.length === 0) throw new AdapterCommandError(operation, request, result);
  const observation = parsePresentationObservation(checkedArtifact, raw);
  if (result.code !== 0 && observation.status !== "error" && observation.status !== "missing") {
    throw new AdapterCommandError(operation, request, result);
  }
  return observation;
}

export async function openPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
): Promise<PresentationObservation> {
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", checkedPath(artifact, "artifact")],
    cwd,
    "lavish presentation open",
  );
}

export async function pollPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
  options: PresentationPollOptions = DEFAULT_PRESENTATION_POLL_OPTIONS,
): Promise<PresentationObservation> {
  const { timeoutMs, commandTimeoutMs } = options;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs <= timeoutMs
  ) {
    throw new TypeError(
      "presentation poll timeout must be a positive integer below its command timeout",
    );
  }
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", "poll", checkedPath(artifact, "artifact"), "--timeout-ms", String(timeoutMs)],
    cwd,
    "lavish presentation poll",
    { commandTimeoutMs },
  );
}
export async function listenPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
): Promise<PresentationObservation> {
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", "poll", checkedPath(artifact, "artifact")],
    cwd,
    "lavish presentation listen",
  );
}
