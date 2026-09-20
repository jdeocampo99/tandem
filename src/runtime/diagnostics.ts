import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DiagnosticValue = string | number | boolean | null;

export type DiagnosticEvent = Readonly<{
  event: string;
  taskId?: string;
  jobId?: string;
  generation?: number;
  role?: string;
  phase?: string;
  details?: Readonly<Record<string, DiagnosticValue>>;
}>;

export function diagnosticsPath(home: string): string {
  return join(resolve(home), "logs", "tandem.jsonl");
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
