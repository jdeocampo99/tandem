/** Linear stays so the coordinator can read tickets while drafting briefs. */
const ALLOWED_MCP_PREFIX = "mcp__linear_";
const WEB_PATH = /(^|;)\s*https?:\/\//iu;

export const COORDINATOR_TOOL_REFUSAL =
  "The coordinator does not browse, fetch web pages, or run MCP tools other than Linear. Hand this work to a Tandem task: steer a running one, or create a new one.";

/**
 * Why the coordinator may not make this tool call, or undefined when it may. Project MCP servers
 * (such as Playwright) load outside `--tools`, so the coordinator's tool allowlist cannot stop them.
 */
export function coordinatorToolRefusal(toolName: string, input: object): string | undefined {
  const path = "path" in input ? input.path : undefined;
  const mcpTool = toolName.startsWith("mcp__")
    ? toolName
    : toolName === "write" && typeof path === "string" && path.startsWith("xd://mcp__")
      ? path.slice("xd://".length)
      : undefined;
  if (mcpTool !== undefined && !mcpTool.startsWith(ALLOWED_MCP_PREFIX)) {
    return COORDINATOR_TOOL_REFUSAL;
  }
  const readsWeb =
    (toolName === "read" || toolName === "grep") &&
    [path].flat().some((entry) => typeof entry === "string" && WEB_PATH.test(entry));
  return readsWeb ? COORDINATOR_TOOL_REFUSAL : undefined;
}
