import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalDialog } from "../session/actions.ts";
import type { SessionEffect, SessionHost, ToolCall, ToolKind } from "../session/events.ts";
import { assertSelectedModel, expectedModelParts } from "../workers/protocol.ts";

/** The custom message type each delivered message is saved under in the OMP session. */
const DELIVERY_MESSAGE_TYPE: Readonly<
  Record<Extract<SessionEffect, { type: "deliver" }>["source"], string>
> = {
  notification: "tandem-notification",
  "prompt-route": "tandem-prompt-route",
  "stall-reminder": "tandem-stall-reminder",
};

const OMP_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  read: "read",
  grep: "search",
  glob: "search",
  web_search: "web-search",
  write: "write",
  edit: "edit",
  bash: "shell",
  ask: "ask",
  task: "subagent",
};

/**
 * Classifies an OMP tool call. MCP tools arrive either under their own `mcp__` name or, through
 * OMP's discovery shim, as a `write` to an `xd://mcp__` path.
 */
export function ompToolCall(
  event: Readonly<{ toolCallId: string; toolName: string; input: object }>,
): ToolCall {
  const path = "path" in event.input ? event.input.path : undefined;
  const command = "command" in event.input ? event.input.command : undefined;
  const base = {
    id: event.toolCallId,
    name: event.toolName,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof command === "string" ? { command } : {}),
  };
  if (event.toolName.startsWith("mcp__")) {
    return { ...base, kind: "mcp", mcpTool: event.toolName };
  }
  if (event.toolName === "write" && typeof path === "string" && path.startsWith("xd://mcp__")) {
    return { ...base, kind: "mcp", mcpTool: path.slice("xd://".length) };
  }
  return { ...base, kind: OMP_TOOL_KINDS[event.toolName] ?? "other" };
}

/** ponytail: mirrors OMP's private sanitizeMCPToolNamePart; tool names are `mcp__<server>_<tool>`. */
export function ompMcpToolPrefix(server: string): string {
  const sanitized = server
    .toLowerCase()
    .replace(/[^a-z_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `mcp__${sanitized.length > 0 ? sanitized : "server"}_`;
}

/** Only the TUI can show an approval dialog; elsewhere approval fails closed. */
export function ompApprovalDialog(ctx: ExtensionContext): ApprovalDialog | undefined {
  return ctx.hasUI && ctx.mode === "tui"
    ? (title, message) => ctx.ui.confirm(title, message)
    : undefined;
}

/** Every call reads the latest OMP context, the one of the event being handled. */
export function ompSessionHost(
  pi: ExtensionAPI,
  currentContext: () => ExtensionContext,
): SessionHost {
  return {
    capabilities: {
      proactiveCompaction: true,
      hiddenMessages: true,
      streamingProgress: true,
      perActionApproval: true,
    },
    perform: (effect) => performOmpEffect(pi, currentContext(), effect),
    confirm: async (title, message) =>
      (await ompApprovalDialog(currentContext())?.(title, message)) ?? false,
    contextTokens: () => currentContext().getContextUsage()?.tokens,
    paneState: () => {
      const ctx = currentContext();
      return {
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
        draft: ctx.ui.getEditorText().trim().length > 0,
      };
    },
    assertSelectedModel: (selector) =>
      assertSelectedModel(expectedModelParts(selector), currentContext().model),
    mcpToolPrefix: ompMcpToolPrefix,
  };
}

/** A hidden part goes first as its own `display: false` message; only the shown one triggers a turn. */
async function performOmpEffect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  effect: SessionEffect,
): Promise<void> {
  switch (effect.type) {
    case "deliver": {
      const customType = DELIVERY_MESSAGE_TYPE[effect.source];
      if (effect.hidden !== undefined) {
        pi.sendMessage(
          {
            customType,
            content: effect.hidden.text,
            display: false,
            ...(effect.hidden.details === undefined ? {} : { details: effect.hidden.details }),
            attribution: "agent",
          },
          { deliverAs: effect.timing },
        );
      }
      pi.sendMessage(
        {
          customType,
          content: effect.text,
          display: true,
          attribution: "agent",
          ...(effect.details === undefined ? {} : { details: effect.details }),
        },
        { deliverAs: effect.timing, ...(effect.triggerTurn ? { triggerTurn: true } : {}) },
      );
      return;
    }
    case "promptAsUser":
      pi.sendUserMessage(effect.text);
      return;
    case "notify":
      ctx.ui.notify(effect.text, effect.level);
      return;
    case "recordEntry":
      pi.appendEntry(effect.entryType, effect.data);
      return;
    case "compact":
      return ctx.compact();
    case "abort":
      ctx.abort();
      return;
    case "shutdown":
      ctx.shutdown();
      return;
  }
}
