import { randomUUID } from "node:crypto";
import { checkedPath, checkedText } from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";
import type { AgentStatusReporter, TerminalBackend } from "../contract.ts";

function statusMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const text = message.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  const bounded = text.slice(0, 500).replace(/[\uD800-\uDBFF]$/u, "");
  return bounded.length === 0 ? undefined : bounded;
}

/** Publish presentation-only lifecycle state; native status never grants ownership. */
export function agentStatusReporter(
  run: CommandRunner,
  options: Parameters<TerminalBackend["agentStatusReporter"]>[0],
): AgentStatusReporter | undefined {
  const environment = options.environment ?? process.env;
  const active = environment.HERDR_ENV?.trim().toLowerCase();
  if (active !== "1" && active !== "true") return undefined;
  const session = environment.HERDR_SESSION ?? environment.HERDR_SESSION_NAME;
  const pane = environment.HERDR_PANE_ID;
  if (session === undefined || pane === undefined) return undefined;
  let sessionId: string;
  let paneId: string;
  try {
    sessionId = checkedText(session, "HERDR_SESSION");
    paneId = checkedText(pane, "HERDR_PANE_ID");
  } catch {
    return undefined;
  }
  const cwd = checkedPath(options.cwd, "cwd");
  const agentLabel = checkedText(options.agentLabel, "agentLabel");
  const timeoutMs = options.timeoutMs ?? 1_500;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Herdr status timeout must be positive");
  }
  // Herdr retains source sequence watermarks after release; a new process/session needs a new source.
  const sourceId = `tandem:${randomUUID()}`;
  let sequence = 0;
  let released = false;
  let lastScheduled: string | undefined;
  let pending = Promise.resolve();

  const enqueue = (action: string, args: readonly string[], key?: string): Promise<void> => {
    const request = {
      argv: [
        "herdr",
        "--session",
        sessionId,
        "pane",
        action,
        paneId,
        "--source",
        sourceId,
        "--agent",
        agentLabel,
        "--seq",
        String(++sequence),
        ...args,
      ],
      cwd,
      timeoutMs,
    };
    pending = pending.then(async () => {
      try {
        const result = await run(request);
        if (result.code === 0) return;
      } catch {
        // An unavailable UI must not interrupt durable work or prevent shutdown.
      }
      if (lastScheduled === key) lastScheduled = undefined;
    });
    return pending;
  };

  return {
    report(state, message) {
      const text = statusMessage(message);
      const key = `${state}\0${text ?? ""}`;
      if (released || key === lastScheduled) return pending;
      lastScheduled = key;
      return enqueue(
        "report-agent",
        ["--state", state, ...(text === undefined ? [] : ["--message", text])],
        key,
      );
    },
    release() {
      if (released) return pending;
      released = true;
      return enqueue("release-agent", []);
    },
  };
}
