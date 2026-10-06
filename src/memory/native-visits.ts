import type { CoordinatorRecord } from "../coordinator/record.ts";
import type { Visit } from "../native/store.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { shouldAutoShowCatchUp } from "./native-view.ts";

export type NativeVisitInput = Readonly<{
  home: string;
  project: string;
  now: string;
  signature: string;
}>;

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
  const { readProjectState } = await import("../native/store.ts");
  const { record, home } = input;
  const signature = (await readProjectState(home, record.repoPath))?.published?.changeSignature;
  return visitNativeProject(
    {
      home,
      project: record.repoPath,
      ...(signature === undefined ? {} : { signature }),
      now: input.now ?? new Date().toISOString(),
    },
    async () => {
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
  );
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

/** Visit state lives in the project's native store. No task state or Tern settings are changed. */
async function updateVisit(
  input: Pick<NativeVisitInput, "home" | "project">,
  effect: (previous: Visit | undefined) => Promise<Visit | undefined>,
): Promise<void> {
  const { withProjectLock } = await import("../native/store.ts");
  await withProjectLock(input.home, input.project, async (store) => {
    const state = await store.read();
    const visit = await effect(state.visit);
    if (visit !== undefined) await store.write({ ...state, visit });
  });
}

/**
 * Invoke only on a project visit, never on a view poll. Failed/uncertain opens stay unacknowledged.
 * The catch-up open runs between two lock holds: it takes seconds, and publication shares the lock.
 */
export async function visitNativeProject(
  input: Omit<NativeVisitInput, "signature"> & Readonly<{ signature?: string }>,
  show: () => Promise<void>,
): Promise<boolean> {
  let shouldShow = false;
  await updateVisit(input, async (previous) => {
    shouldShow =
      input.signature !== undefined &&
      shouldAutoShowCatchUp({
        now: input.now,
        currentSignature: input.signature,
        ...(previous?.lastVisibleAt === undefined ? {} : { lastVisibleAt: previous.lastVisibleAt }),
        ...(previous?.previousSignature === undefined
          ? {}
          : { previousSignature: previous.previousSignature }),
      });
    return undefined;
  });
  if (shouldShow) await show();
  await updateVisit(input, async (previous) => {
    const signature = input.signature ?? previous?.previousSignature;
    return {
      lastOpenedAt: input.now,
      lastVisibleAt: input.now,
      ...(signature === undefined ? {} : { previousSignature: signature }),
    };
  });
  return shouldShow;
}

/** First publication fills a known visit's missing baseline without changing its timestamp. */
export async function recordNativePublication(
  input: Pick<NativeVisitInput, "home" | "project" | "signature">,
): Promise<void> {
  const { readProjectState } = await import("../native/store.ts");
  const saved = (await readProjectState(input.home, input.project))?.visit;
  if (saved === undefined || saved.previousSignature !== undefined) return;
  await updateVisit(input, async (previous) =>
    previous === undefined || previous.previousSignature !== undefined
      ? undefined
      : { ...previous, previousSignature: input.signature },
  );
}

export async function dismissNativeCatchUp(input: NativeVisitInput): Promise<void> {
  await updateVisit(input, async () => ({
    lastOpenedAt: input.now,
    lastVisibleAt: input.now,
    previousSignature: input.signature,
    dismissedSignature: input.signature,
  }));
}

/** Heartbeats advance at most once a minute; transitions capture visibility without opening a view. */
export async function recordNativeVisibility(
  input: Omit<NativeVisitInput, "signature"> &
    Readonly<{ signature?: string; heartbeat?: boolean }>,
): Promise<void> {
  await updateVisit(input, async (previous) => {
    const elapsed =
      previous?.lastVisibleAt === undefined
        ? undefined
        : Date.parse(input.now) - Date.parse(previous.lastVisibleAt);
    if (input.heartbeat && elapsed !== undefined && elapsed < 60_000) return undefined;
    const signature = input.signature ?? previous?.previousSignature;
    const lastVisibleAt =
      elapsed !== undefined && elapsed <= 0 ? (previous?.lastVisibleAt ?? input.now) : input.now;
    if (previous?.lastVisibleAt === lastVisibleAt && previous.previousSignature === signature)
      return undefined;
    return {
      lastOpenedAt: previous?.lastOpenedAt ?? input.now,
      lastVisibleAt,
      ...(signature === undefined ? {} : { previousSignature: signature }),
    };
  });
}
