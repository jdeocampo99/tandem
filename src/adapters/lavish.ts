import type { CommandRequest, CommandRunner } from "../contracts.ts";
import {
  AdapterCommandError,
  AdapterProtocolError,
  checkedPath,
  runChecked,
} from "./primitives.ts";

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

/** `reopen` also opens a session the user ended in the browser; pass it only when they ask. */
export async function openPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
  options: Readonly<{ readonly reopen?: boolean }> = {},
): Promise<PresentationObservation> {
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", checkedPath(artifact, "artifact"), ...(options.reopen ? ["--reopen"] : [])],
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
/** Waits for the user's next feedback; `agentReply` first shows a short reply in the browser. */
export async function listenPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
  options: Readonly<{ readonly agentReply?: string | undefined }> = {},
): Promise<PresentationObservation> {
  const reply = options.agentReply === undefined ? [] : ["--agent-reply", options.agentReply];
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", "poll", checkedPath(artifact, "artifact"), ...reply],
    cwd,
    "lavish presentation listen",
  );
}

/** Ends a session as the agent, which still allows a plain reopen later. */
export async function endPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
): Promise<void> {
  await runChecked(
    run,
    {
      argv: ["lavish-axi", "end", checkedPath(artifact, "artifact")],
      cwd: checkedPath(cwd, "cwd"),
    },
    "lavish presentation end",
  );
}

/**
 * The plain messages in one poll's feedback, joined, from both feedback rows and prompt rows.
 * Prompt rows holding a page's structured action (`isAction` on the parsed JSON) are left out.
 */
export function feedbackMessages(
  rawFeedback: string,
  isAction: (action: unknown) => boolean,
): string | undefined {
  const messages: string[] = [];
  let promptSuffix = -1;
  let feedback = false;
  for (const line of rawFeedback.split(/\r?\n/u)) {
    const prompts = /^prompts\[\d+\]\{([^}]+)\}:$/u.exec(line);
    if (prompts !== null) {
      const fields = prompts[1]?.split(",") ?? [];
      promptSuffix = fields.indexOf("prompt") === 1 ? fields.length - 2 : -1;
      feedback = false;
      continue;
    }
    if (/^feedback\[\d+\]\{/u.test(line)) {
      promptSuffix = -1;
      feedback = true;
      continue;
    }
    if (feedback) {
      const message = /^\s+message:\s*(.*)$/u.exec(line)?.[1]?.trim();
      if (message) messages.push(message);
    } else if (promptSuffix >= 0) {
      const row = /^\s+"(?:[^"\\]|\\.)*",(.*)$/u.exec(line)?.[1];
      if (row === undefined) continue;
      const quoted = /^"(?:[^"\\]|\\.)*"/u.exec(row)?.[0];
      let value: string;
      if (quoted === undefined) {
        const parts = row.split(",");
        value = parts
          .slice(0, parts.length > promptSuffix ? parts.length - promptSuffix : parts.length)
          .join(",")
          .trim();
      } else {
        try {
          const parsed: unknown = JSON.parse(quoted);
          value = typeof parsed === "string" ? parsed.trim() : "";
        } catch {
          value = row.trim();
        }
      }
      if (!value) continue;
      try {
        if (isAction(JSON.parse(value))) continue;
      } catch {
        // Ordinary freeform text need not be JSON.
      }
      messages.push(value);
    }
  }
  return messages.length > 0 ? messages.join("\n\n") : undefined;
}
