import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openPresentation } from "../adapters/lavish.ts";
import type { CommandRunner, IsoTimestamp } from "../contracts.ts";
import type { ReportView } from "./model.ts";
import { renderReportHtml } from "./render.ts";

/**
 * Writes the rendered `tandem report` page under the Tandem home and opens it in Lavish. The page
 * is a one-off view: nothing polls it for feedback, and a failed open leaves the file for the user.
 */
export type PublishedReport = Readonly<{
  readonly path: string;
  readonly opened: boolean;
  /** The Lavish session's browser link, when it reported one. */
  readonly url?: string;
  /** Why Lavish did not open the page; absent when it opened or opening was not asked for. */
  readonly openError?: string;
}>;

export function reportsDirectory(home: string): string {
  return join(home, "reports");
}

/** `report-2030-01-01T09-30-00-000Z.html`: the generation time with no `:` or `.` in it. */
export function reportFileName(generatedAt: IsoTimestamp): string {
  return `report-${generatedAt.replace(/[^0-9A-Za-z-]/gu, "-")}.html`;
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
  const path = join(directory, reportFileName(input.view.generatedAt));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, renderReportHtml(input.view), { mode: 0o600 });
  if (!input.open) return { path, opened: false };
  try {
    const observation = await openPresentation(input.run, path, directory);
    if (observation.status === "error" || observation.status === "missing") {
      return { path, opened: false, openError: `Lavish reported ${observation.status}` };
    }
    return {
      path,
      opened: true,
      ...(observation.sessionUrl === undefined ? {} : { url: observation.sessionUrl }),
    };
  } catch (error) {
    return {
      path,
      opened: false,
      openError: error instanceof Error ? error.message : String(error),
    };
  }
}
