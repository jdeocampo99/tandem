import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IsoTimestamp, TerminalName } from "../contracts.ts";
import { type BoardView, isBoardView } from "./view.ts";

/** A project's open coordinator chat, so the panel can focus it. */
export type PanelCoordinator = Readonly<{
  readonly terminal?: TerminalName;
  readonly repoPath: string;
  readonly project: string;
  readonly workspaceId: string;
  readonly paneId: string;
}>;

/**
 * The board as a coordinator last read it, for panels to draw without taking the state lock. Each
 * coordinator rewrites the whole file on every reconcile.
 */
export type BoardSnapshot = Readonly<{
  readonly version: 1;
  readonly writtenAt: IsoTimestamp;
  readonly board: BoardView;
  readonly coordinators: readonly PanelCoordinator[];
}>;

export function boardSnapshotPath(home: string): string {
  return join(home, "board-snapshot.json");
}

/** The snapshot in `text`, or undefined when it is not one this version of Tandem reads. */
export function parseBoardSnapshot(text: string): BoardSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const snapshot = value as Record<string, unknown>;
  const valid =
    snapshot.version === 1 &&
    typeof snapshot.writtenAt === "string" &&
    isBoardView(snapshot.board) &&
    Array.isArray(snapshot.coordinators) &&
    snapshot.coordinators.every(isPanelCoordinator);
  return valid ? (snapshot as BoardSnapshot) : undefined;
}

/** Replaces the snapshot atomically, so a panel never reads half a file. */
export async function writeBoardSnapshot(home: string, snapshot: BoardSnapshot): Promise<void> {
  const path = boardSnapshotPath(home);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The last snapshot written, or undefined when none has been; throws when it cannot be read. */
export async function readBoardSnapshot(home: string): Promise<BoardSnapshot | undefined> {
  const path = boardSnapshotPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  const snapshot = parseBoardSnapshot(text);
  if (snapshot === undefined) throw new Error(`${path} is not a board snapshot Tandem can read`);
  return snapshot;
}

function isPanelCoordinator(value: unknown): value is PanelCoordinator {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.terminal === undefined || entry.terminal === "herdr" || entry.terminal === "tern") &&
    typeof entry.repoPath === "string" &&
    typeof entry.project === "string" &&
    typeof entry.workspaceId === "string" &&
    typeof entry.paneId === "string"
  );
}
