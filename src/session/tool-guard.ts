import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionHost, ToolCall } from "./events.ts";

const WEB_PATH = /(^|;)\s*https?:\/\//iu;
const URI_PATH = /^[a-z][a-z0-9+.-]*:\/\//iu;

export const COORDINATOR_TOOL_REFUSAL =
  "The coordinator does not browse, fetch web pages, or use MCP servers outside this project's coordinatorMcpServers setting. Hand this work to a Tandem task: steer a running one, or create a new one. The user can allow a server for the coordinator with `tandem config`.";

export const COORDINATOR_RESEARCH_RUNNING_REFUSAL =
  "Research is running for this project, so the coordinator does not read repository files itself. To learn something new, steer the running research task with the question, or create a new research task; its report arrives as a notification. Reports and briefs stay readable.";

export type CoordinatorToolPolicy = Readonly<{
  /** The MCP servers this project lets the coordinator use; read only for MCP calls. */
  readonly allowedServers: () => Promise<readonly string[]>;
  /** Whether a research task for this project is queued or running; read only for file reads. */
  readonly researchRunning: () => Promise<boolean>;
  readonly mcpToolPrefix: SessionHost["mcpToolPrefix"];
  /** The Tandem home, whose reports and briefs stay readable. */
  readonly home: string;
  /** The coordinator's working directory, which relative read paths resolve against. */
  readonly cwd: string;
  /** The user's home directory, which `~/` read paths resolve against. */
  readonly userHome: string;
  readonly realpath: (path: string) => Promise<string>;
}>;

/**
 * Why the coordinator may not make this tool call, or undefined when it may. Project MCP servers
 * (such as Playwright) load outside `--tools`, so the coordinator's tool allowlist cannot stop
 * them. The coordinator has no search tools, so it reads only paths it was pointed at, and none
 * outside Tandem's own records while a scout is researching the same project.
 */
export async function coordinatorToolRefusal(
  call: ToolCall,
  policy: CoordinatorToolPolicy,
): Promise<string | undefined> {
  if (call.kind === "mcp") {
    const tool = call.mcpTool ?? call.name;
    const allowed = (await policy.allowedServers()).some((server) =>
      tool.startsWith(policy.mcpToolPrefix(server)),
    );
    return allowed ? undefined : COORDINATOR_TOOL_REFUSAL;
  }
  const path = call.path;
  if (call.kind !== "read" || path === undefined) return undefined;
  if (WEB_PATH.test(path)) return COORDINATOR_TOOL_REFUSAL;
  if (URI_PATH.test(path) || (await isTandemRecord(path, policy))) return undefined;
  return (await policy.researchRunning()) ? COORDINATOR_RESEARCH_RUNNING_REFUSAL : undefined;
}

/** Reports and briefs live under the Tandem home; worker worktrees under its pool do not count. */
async function isTandemRecord(path: string, policy: CoordinatorToolPolicy): Promise<boolean> {
  const target = path.startsWith("~/")
    ? join(policy.userHome, path.slice(2))
    : resolve(policy.cwd, path);
  const homes = [policy.home, await policy.realpath(policy.home).catch(() => policy.home)];
  return homes.some((home) => isInside(home, target) && !isInside(join(home, "pool"), target));
}

function isInside(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}
