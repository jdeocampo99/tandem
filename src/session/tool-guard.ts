import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolCall } from "./events.ts";

const WEB_PATH = /(^|;)\s*https?:\/\//iu;
const URI_PATH = /^[a-z][a-z0-9+.-]*:\/\//iu;

export const COORDINATOR_TOOL_REFUSAL =
  "The coordinator does not read web URLs directly. Use an OMP MCP tool for web access, or hand this work to a Tandem research task.";

export const COORDINATOR_RESEARCH_RUNNING_REFUSAL =
  "Research is running for this project, so the coordinator does not read repository files itself. To learn something new, steer the running research task with the question, or create a new research task; its report arrives as a notification. Reports and briefs stay readable.";

export type CoordinatorToolPolicy = Readonly<{
  /** Whether a research task for this project is queued or running; read only for file reads. */
  readonly researchRunning: () => Promise<boolean>;
  /** The Tandem home, whose reports and briefs stay readable. */
  readonly home: string;
  /** The coordinator's working directory, which relative read paths resolve against. */
  readonly cwd: string;
  /** The user's home directory, which `~/` read paths resolve against. */
  readonly userHome: string;
  readonly realpath: (path: string) => Promise<string>;
}>;

/**
 * Why the coordinator may not make this tool call, or undefined when it may. The coordinator may
 * use every MCP tool OMP has loaded; this guard only protects web reads and repository reads while
 * a scout is researching the same project.
 */
export async function coordinatorToolRefusal(
  call: ToolCall,
  policy: CoordinatorToolPolicy,
): Promise<string | undefined> {
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
