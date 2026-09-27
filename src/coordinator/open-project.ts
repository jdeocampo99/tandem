import { join } from "node:path";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import { listCoordinatorRecords } from "./registry.ts";
import { TANDEM_CHECKOUT } from "./tandem-checkout.ts";

/**
 * Variables that tie a process to the coordinator pane it runs in. The launch runs without them, so
 * it neither claims this coordinator's checkout nor treats this pane as the one to attach to.
 */
const COORDINATOR_BINDINGS = [
  "TANDEM_REPO",
  "TANDEM_SOURCE_REPO",
  "TANDEM_PARENT_WORKSPACE",
  "HERDR_ENV",
  "HERDR_SESSION",
  "HERDR_SESSION_NAME",
  "HERDR_WORKSPACE_ID",
  "HERDR_PANE_ID",
] as const;

export type OpenProjectInput = Readonly<{
  readonly repoPath: string;
  readonly home: string;
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly tandemCheckout?: string;
}>;

/** `tandem PATH --no-attach` for one saved project, in the same home and target Herdr session. */
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

/**
 * Opens a saved project's coordinator beside the calling one, through the normal front door, then
 * brings its workspace forward so the user lands in the new chat. Whether it could be brought
 * forward is reported, never a failure: the project is open either way.
 */
export async function openProject(
  run: CommandRunner,
  input: OpenProjectInput,
): Promise<Readonly<{ readonly focused: boolean }>> {
  const result = await run(openProjectCommand(input));
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).replace(/^tandem: /u, "");
    throw new Error(
      `Tandem could not open ${input.repoPath}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  const records = await listCoordinatorRecords(input.home, input.sessionId);
  const record = records.find((candidate) => candidate.repoPath === input.repoPath);
  if (record === undefined) return { focused: false };
  const focus = await run({
    argv: [
      "herdr",
      "--session",
      input.sessionId,
      "workspace",
      "focus",
      record.endpoint.workspaceId,
    ],
    cwd: input.repoPath,
  });
  return { focused: focus.code === 0 };
}
