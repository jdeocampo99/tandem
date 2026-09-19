import { resolve } from "node:path";
import { resolveTandemEnvironment, type TandemEnvironmentSource } from "../config/environment.ts";
import type { TerminalInvocation } from "./arguments.ts";

function terminalProcessEnvironmentSnapshot(
  source: TandemEnvironmentSource | undefined,
): TandemEnvironmentSource {
  if (source !== undefined) return source;
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) values[key] = value;
  return values;
}
export const DEFAULT_TERMINAL_SESSION_ID = "tandem";

export type TerminalEnvironment = Readonly<{
  readonly cwd: string;
  readonly home: string;
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly source: TandemEnvironmentSource;
}>;

export type TerminalEnvironmentDependencies = Readonly<{
  readonly cwd?: string;
  readonly processEnvironment?: TandemEnvironmentSource;
}>;

export function resolveTerminalEnvironment(
  invocation: TerminalInvocation,
  dependencies: TerminalEnvironmentDependencies,
): TerminalEnvironment {
  const source = terminalProcessEnvironmentSnapshot(dependencies.processEnvironment);
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const resolved = resolveTandemEnvironment(
    source,
    { cwd, sessionId: DEFAULT_TERMINAL_SESSION_ID },
    {
      repo: cwd,
      ...(invocation.sessionId === undefined ? {} : { sessionId: invocation.sessionId }),
      ...(invocation.home === undefined ? {} : { home: invocation.home }),
      ...(invocation.poolRoot === undefined ? {} : { poolRoot: invocation.poolRoot }),
    },
  );
  const sessionId = resolved.sessionId;
  if (sessionId.trim().length === 0 || /[\r\n\u2028\u2029]/u.test(sessionId)) {
    throw new Error("session id must be non-empty single-line text");
  }
  return {
    cwd,
    home: resolve(resolved.home),
    sessionId,
    poolRoot: resolve(resolved.poolRoot),
    source,
  };
}
