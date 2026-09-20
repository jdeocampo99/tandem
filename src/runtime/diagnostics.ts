import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { UsageRecord } from "./usage.ts";

export type DiagnosticValue = string | number | boolean | null;

export type DiagnosticEvent = Readonly<{
  readonly event: string;
  readonly taskId?: string;
  readonly jobId?: string;
  readonly generation?: number;
  readonly role?: string;
  readonly phase?: string;
  readonly details?: Readonly<Record<string, DiagnosticValue>>;
  /** Optional bounded provider usage; absent on events with no provider call and on events written before this field existed. */
  readonly usage?: UsageRecord;
}>;

export function diagnosticsPath(home: string): string {
  return join(resolve(home), "logs", "tandem.jsonl");
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function readPromptRoutingLog(home: string, limit = 20): Promise<readonly string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("log limit must be a positive integer");
  }
  let contents: string;
  try {
    contents = await readFile(diagnosticsPath(home), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const events: string[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "event" in value &&
        typeof value.event === "string" &&
        value.event.startsWith("prompt-route-")
      ) {
        events.push(trimmed);
      }
    } catch {
      // Ignore incomplete or unrelated diagnostic lines.
    }
  }
  return events.length <= limit ? events : events.slice(events.length - limit);
}

/** Best-effort append-only history; diagnostics must never change workflow behavior. */
export async function appendDiagnosticEvent(
  home: string,
  event: DiagnosticEvent,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  try {
    const path = diagnosticsPath(home);
    const directory = join(resolve(home), "logs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await appendFile(
      path,
      `${JSON.stringify({ timestamp: now(), pid: process.pid, ...event })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(path, 0o600);
  } catch {
    // Observability must not make a state transition fail.
  }
}
