import { readBoard } from "../board/read.ts";
import type { StatusFooter } from "../board/terminal.ts";
import type { BoardView } from "../board/view.ts";
import type { CommandRunner } from "../contracts.ts";
import { listCoordinatorRecords } from "../coordinator/registry.ts";

/** What `tandem status` shows: the board across every project, plus its footer. */
export type TandemStatus = StatusFooter & Readonly<{ readonly board: BoardView }>;

/** The commit the `tandem` command runs from; `tandem update` loads this into coordinators. */
export async function tandemCodeVersion(run: CommandRunner, tandemRoot: string): Promise<string> {
  const result = await run({
    argv: ["git", "-C", tandemRoot, "log", "-1", "--format=%h %s"],
    cwd: tandemRoot,
  });
  const version = result.code === 0 ? result.stdout.trim() : "";
  return `${version.length > 0 ? version : "unknown commit"} (${tandemRoot})`;
}

/** Reads saved state only; pull requests are what PR watch last saved, never a fresh GitHub read. */
export async function readTandemStatus(
  input: Readonly<{
    readonly code: string;
    readonly home: string;
    readonly sessionId: string;
  }>,
): Promise<TandemStatus> {
  return {
    code: input.code,
    coordinators: (await listCoordinatorRecords(input.home, input.sessionId)).map(
      (record) => record.repoPath,
    ),
    board: await readBoard(input.home, () => new Date().toISOString()),
  };
}
