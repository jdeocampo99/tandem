import type { CoordinatorRecord } from "../coordinator/record.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";

/** Called after a visible project open or switch, never from background launch or view polling. */
export async function maybeShowCatchUp(
  terminal: TerminalBackend,
  input: Readonly<{
    home: string;
    record: Pick<CoordinatorRecord, "repoPath" | "endpoint"> & {
      worktree: Pick<CoordinatorRecord["worktree"], "path">;
    };
    windowId?: string;
    now?: string;
  }>,
): Promise<boolean> {
  const views = terminal.views;
  if (views === undefined || input.record.endpoint.terminal !== terminal.name) return false;
  // Keep the native store out of unrelated terminal and worker startup paths.
  const { readPublished, recordVisit } = await import("../native/store.ts");
  const { record, home } = input;
  const signature = (await readPublished(home, record.repoPath))?.changeSignature;
  return recordVisit(home, record.repoPath, {
    kind: "entry",
    now: input.now ?? new Date().toISOString(),
    ...(signature === undefined ? {} : { signature }),
    showCatchUp: async () => {
      const result = await views.open({
        coordinator: record.endpoint,
        cwd: record.worktree.path,
        home,
        origin: {
          paneId: record.endpoint.paneId,
          cwd: record.worktree.path,
          ...(input.windowId === undefined ? {} : { windowId: input.windowId }),
        },
        view: { kind: "catchup" },
      });
      if (!result.opened)
        throw new Error(result.warnings.join("; ") || "Tern could not open project catch-up");
    },
  });
}

/** Optional catch-up never changes a successful entry into a failure or acknowledges a failed open. */
export async function tryShowCatchUp(
  terminal: TerminalBackend,
  input: Parameters<typeof maybeShowCatchUp>[1],
): Promise<Readonly<{ shown: boolean; warning?: string }>> {
  try {
    return { shown: await maybeShowCatchUp(terminal, input) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { shown: false, warning: `Project opened, but catch-up is unavailable: ${detail}` };
  }
}
