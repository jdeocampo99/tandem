import { join } from "node:path";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import { TANDEM_CHECKOUT } from "./tandem-checkout.ts";

/**
 * Variables that tie a process to the coordinator pane it runs in. The launch runs without them, so
 * it neither claims this coordinator's checkout nor treats this pane as the one to attach to.
 */
const COORDINATOR_BINDINGS = [
  "TANDEM_REPO",
  "TANDEM_SOURCE_REPO",
  "TANDEM_PARENT_WORKSPACE",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
] as const;

export type OpenProjectInput = Readonly<{
  readonly repoPath: string;
  readonly home: string;
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly tandemCheckout?: string;
}>;

/** `tandem PATH --no-attach` for one saved project, in the same home and Herdr session. */
export function openProjectCommand(input: OpenProjectInput): CommandRequest {
  const main = join(input.tandemCheckout ?? TANDEM_CHECKOUT, "src", "main.ts");
  return {
    argv: [
      "env",
      ...COORDINATOR_BINDINGS.flatMap((name) => ["-u", name]),
      "bun",
      main,
      input.repoPath,
      "--home",
      input.home,
      "--session",
      input.sessionId,
      "--pool-root",
      input.poolRoot,
      "--no-attach",
    ],
    cwd: input.repoPath,
  };
}

/** Opens a saved project's coordinator beside the calling one, through the normal front door. */
export async function openProject(run: CommandRunner, input: OpenProjectInput): Promise<void> {
  const result = await run(openProjectCommand(input));
  if (result.code === 0) return;
  const detail = (result.stderr.trim() || result.stdout.trim()).replace(/^tandem: /u, "");
  throw new Error(
    `Tandem could not open ${input.repoPath}${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}
