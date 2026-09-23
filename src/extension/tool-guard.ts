const WEB_PATH = /(^|;)\s*https?:\/\//iu;

export const COORDINATOR_TOOL_REFUSAL =
  "The coordinator does not browse, fetch web pages, or use MCP servers outside this project's coordinatorMcpServers setting. Hand this work to a Tandem task: steer a running one, or create a new one. The user can allow a server for the coordinator with `tandem config`.";

/** ponytail: mirrors OMP's private sanitizeMCPToolNamePart; tool names are `mcp__<server>_<tool>`. */
function mcpToolPrefix(server: string): string {
  const sanitized = server
    .toLowerCase()
    .replace(/[^a-z_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `mcp__${sanitized.length > 0 ? sanitized : "server"}_`;
}

/**
 * Why the coordinator may not make this tool call, or undefined when it may. Project MCP servers
 * (such as Playwright) load outside `--tools`, so the coordinator's tool allowlist cannot stop
 * them. The allowed servers are read only for MCP calls.
 */
export async function coordinatorToolRefusal(
  toolName: string,
  input: object,
  allowedServers: () => Promise<readonly string[]>,
): Promise<string | undefined> {
  const path = "path" in input ? input.path : undefined;
  const mcpTool = toolName.startsWith("mcp__")
    ? toolName
    : toolName === "write" && typeof path === "string" && path.startsWith("xd://mcp__")
      ? path.slice("xd://".length)
      : undefined;
  if (mcpTool !== undefined) {
    const allowed = (await allowedServers()).some((server) =>
      mcpTool.startsWith(mcpToolPrefix(server)),
    );
    return allowed ? undefined : COORDINATOR_TOOL_REFUSAL;
  }
  const readsWeb =
    (toolName === "read" || toolName === "grep") &&
    [path].flat().some((entry) => typeof entry === "string" && WEB_PATH.test(entry));
  return readsWeb ? COORDINATOR_TOOL_REFUSAL : undefined;
}
