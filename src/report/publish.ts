import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandExecutionError, CommandStartError } from "../adapters/commands.ts";
import { openPresentation, type PresentationObservation } from "../adapters/lavish.ts";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { CommandRunner, IsoTimestamp } from "../contracts.ts";
import type { ReportView } from "./model.ts";
import { renderReportHtml } from "./render.ts";

/**
 * Writes the rendered `tandem report` page under the Tandem home, prunes older report pages, and
 * opens the new one in Lavish. The page is a one-off view: nothing polls it for feedback, and a
 * failed open leaves the file for the user.
 */
export type PublishedReport = Readonly<{
  readonly path: string;
  readonly opened: boolean;
  /** The Lavish session's browser link, when it reported one. */
  readonly url?: string;
  /** One plain sentence on why Lavish did not open the page; absent when it opened or was not asked. */
  readonly openError?: string;
  /** A short raw detail behind `openError`, only when it adds something the user can use. */
  readonly openErrorDetail?: string;
}>;

/** How many report pages `<home>/reports/` keeps, counting the one just written. */
export const REPORT_FILES_KEPT = 20;

const LAVISH_MISSING_MESSAGE = "Lavish isn't installed or couldn't start.";
const LAVISH_FAILED_MESSAGE = "Lavish couldn't open the page.";

/** Longer raw details are left out rather than cut mid-sentence. */
const MAX_DETAIL_CHARS = 120;

const REPORT_FILE_PATTERN = /^report-[0-9A-Za-z-]+\.html$/u;

function reportsDirectory(home: string): string {
  return join(home, "reports");
}

/** `report-2030-01-01T09-30-00-000Z.html`: the generation time with no `:` or `.` in it. */
export function reportFileName(generatedAt: IsoTimestamp): string {
  return `report-${generatedAt.replace(/[^0-9A-Za-z-]/gu, "-")}.html`;
}

export type ReportDirectoryEntry = Readonly<{
  readonly name: string;
  /** True only for a regular file; symlinks, directories, and anything else are false. */
  readonly isFile: boolean;
}>;

/**
 * The report pages to delete so at most `keep` remain: regular `report-*.html` files only, oldest
 * first (names sort by generation time), never `current`, the page just written.
 */
export function reportFilesToPrune(
  entries: readonly ReportDirectoryEntry[],
  current: string,
  keep: number = REPORT_FILES_KEPT,
): readonly string[] {
  const reports = entries
    .filter((entry) => entry.isFile && REPORT_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const older = reports
    .filter((name) => name !== current)
    .sort()
    .reverse();
  const slots = Math.max(0, keep - (reports.includes(current) ? 1 : 0));
  return older.slice(slots);
}

/** Best effort: a directory that cannot be listed or a file that cannot go is left as it is. */
async function pruneReportFiles(directory: string, current: string): Promise<void> {
  let entries: ReportDirectoryEntry[];
  try {
    const listing = await readdir(directory, { withFileTypes: true });
    entries = listing.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch {
    return;
  }
  for (const name of reportFilesToPrune(entries, current)) {
    try {
      await unlink(join(directory, name));
    } catch {
      // Already gone or not removable; pruning never fails the report.
    }
  }
}

export type LavishOpenFailure =
  | Readonly<{ readonly kind: "threw"; readonly error: unknown }>
  | Readonly<{ readonly kind: "reported"; readonly observation: PresentationObservation }>;

function shortDetail(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line === undefined || line.length > MAX_DETAIL_CHARS ? undefined : line;
}

function isMissingCommand(error: unknown): boolean {
  if (error instanceof CommandStartError) return true;
  if (error instanceof AdapterCommandError) return error.result.code === 127;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return true;
  }
  return error instanceof Error && /\bENOENT\b|not found in \$PATH/u.test(error.message);
}

/** Maps a failed `lavish-axi` open to one sentence the user can act on, plus an optional detail. */
export function describeLavishFailure(
  failure: LavishOpenFailure,
): Readonly<{ readonly message: string; readonly detail?: string }> {
  if (failure.kind === "reported") {
    const detail = shortDetail(failure.observation.raw.replace(/^error:/u, ""));
    return { message: LAVISH_FAILED_MESSAGE, ...(detail === undefined ? {} : { detail }) };
  }
  const { error } = failure;
  if (isMissingCommand(error)) return { message: LAVISH_MISSING_MESSAGE };
  const detail =
    error instanceof AdapterCommandError
      ? shortDetail(error.result.stderr)
      : error instanceof CommandExecutionError && error.reason === "timeout"
        ? "lavish-axi timed out."
        : undefined;
  return { message: LAVISH_FAILED_MESSAGE, ...(detail === undefined ? {} : { detail }) };
}

export async function publishReport(
  input: Readonly<{
    readonly home: string;
    readonly run: CommandRunner;
    readonly view: ReportView;
    /** False writes the file and leaves it closed. */
    readonly open: boolean;
  }>,
): Promise<PublishedReport> {
  const directory = reportsDirectory(input.home);
  const name = reportFileName(input.view.generatedAt);
  const path = join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, renderReportHtml(input.view), { mode: 0o600 });
  await pruneReportFiles(directory, name);
  if (!input.open) return { path, opened: false };
  let failure: LavishOpenFailure;
  try {
    const observation = await openPresentation(input.run, path, directory);
    if (observation.status !== "error" && observation.status !== "missing") {
      return {
        path,
        opened: true,
        ...(observation.sessionUrl === undefined ? {} : { url: observation.sessionUrl }),
      };
    }
    failure = { kind: "reported", observation };
  } catch (error) {
    failure = { kind: "threw", error };
  }
  const { message, detail } = describeLavishFailure(failure);
  return {
    path,
    opened: false,
    openError: message,
    ...(detail === undefined ? {} : { openErrorDetail: detail }),
  };
}
