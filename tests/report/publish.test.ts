import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CommandStartError, CommandTimeoutError } from "../../src/adapters/commands.ts";
import { AdapterCommandError, AdapterProtocolError } from "../../src/adapters/primitives.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { buildReportView } from "../../src/report/build.ts";
import {
  describeLavishFailure,
  publishReport,
  REPORT_FILES_KEPT,
  type ReportDirectoryEntry,
  reportFileName,
  reportFilesToPrune,
} from "../../src/report/publish.ts";

const VIEW = buildReportView({
  tasks: [],
  generatedAt: "2030-01-02T03:04:05.678Z",
  scopeLabel: "tandem",
  unreadableEvents: 0,
});

async function withHome(action: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tandem-report-publish-"));
  try {
    await action(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function recordingRunner(
  respond: (request: CommandRequest) => CommandResult | Promise<CommandResult>,
): {
  readonly calls: CommandRequest[];
  readonly run: (r: CommandRequest) => Promise<CommandResult>;
} {
  const calls: CommandRequest[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return respond(request);
    },
  };
}

test("the file name is the generation time with no colons or dots", () => {
  expect(reportFileName("2030-01-02T03:04:05.678Z")).toBe("report-2030-01-02T03-04-05-678Z.html");
});

test("publish writes the page under the home and opens it in Lavish", async () => {
  await withHome(async (home) => {
    const runner = recordingRunner(() => ({
      code: 0,
      stdout: "session:\n  status: opened\n  url: http://127.0.0.1:4000/s/1\n",
      stderr: "",
    }));
    const published = await publishReport({ home, run: runner.run, view: VIEW, open: true });
    const path = join(home, "reports", "report-2030-01-02T03-04-05-678Z.html");
    expect(published).toEqual({ path, opened: true, url: "http://127.0.0.1:4000/s/1" });
    const html = await readFile(path, "utf8");
    expect(html).toContain('id="report-data"');
    expect(html).toContain("tandem");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(runner.calls).toEqual([{ argv: ["lavish-axi", path], cwd: join(home, "reports") }]);
  });
});

test("publish keeps the file and reports why when Lavish is missing or fails", async () => {
  await withHome(async (home) => {
    const missing = recordingRunner(() => {
      throw new Error("spawn lavish-axi ENOENT");
    });
    const thrown = await publishReport({ home, run: missing.run, view: VIEW, open: true });
    expect(thrown).toEqual({
      path: thrown.path,
      opened: false,
      openError: "Lavish isn't installed or couldn't start.",
    });
    expect(await readFile(thrown.path, "utf8")).toContain("<html");

    const failing = recordingRunner(() => ({
      code: 1,
      stdout: "error: browser unavailable\ncode: INTERNAL\n",
      stderr: "",
    }));
    const reported = await publishReport({ home, run: failing.run, view: VIEW, open: true });
    expect(reported).toEqual({
      path: thrown.path,
      opened: false,
      openError: "Lavish couldn't open the page.",
      openErrorDetail: "browser unavailable",
    });

    const malformed = recordingRunner(() => ({ code: 0, stdout: "garbage\n", stderr: "" }));
    const garbled = await publishReport({ home, run: malformed.run, view: VIEW, open: true });
    expect(garbled).toEqual({
      path: thrown.path,
      opened: false,
      openError: "Lavish couldn't open the page.",
    });
  });
});

const REQUEST = { argv: ["lavish-axi", "/tmp/r.html"], cwd: "/tmp" } as const;

test("Lavish failures map to one plain sentence, with a short detail only when useful", () => {
  const missing = { message: "Lavish isn't installed or couldn't start." };
  expect(
    describeLavishFailure({ kind: "threw", error: new CommandStartError(REQUEST, "ENOENT") }),
  ).toEqual(missing);
  expect(
    describeLavishFailure({
      kind: "threw",
      error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    }),
  ).toEqual(missing);
  expect(
    describeLavishFailure({
      kind: "threw",
      error: new AdapterCommandError("lavish presentation open", REQUEST, {
        code: 127,
        stdout: "",
        stderr: "lavish-axi: command not found",
      }),
    }),
  ).toEqual(missing);

  expect(
    describeLavishFailure({
      kind: "threw",
      error: new AdapterProtocolError("lavish presentation", "unknown session status x", "raw"),
    }),
  ).toEqual({ message: "Lavish couldn't open the page." });
  expect(
    describeLavishFailure({
      kind: "threw",
      error: new AdapterCommandError("lavish presentation open", REQUEST, {
        code: 2,
        stdout: "",
        stderr: "\nport 4000 in use\nstack line\n",
      }),
    }),
  ).toEqual({ message: "Lavish couldn't open the page.", detail: "port 4000 in use" });
  expect(
    describeLavishFailure({
      kind: "threw",
      error: new AdapterCommandError("lavish presentation open", REQUEST, {
        code: 2,
        stdout: "",
        stderr: "x".repeat(500),
      }),
    }),
  ).toEqual({ message: "Lavish couldn't open the page." });
  expect(
    describeLavishFailure({ kind: "threw", error: new CommandTimeoutError(REQUEST, 5_000) }),
  ).toEqual({ message: "Lavish couldn't open the page.", detail: "lavish-axi timed out." });
});

function entries(...names: readonly string[]): readonly ReportDirectoryEntry[] {
  return names.map((name) => ({ name, isFile: true }));
}

function reportName(index: number): string {
  return `report-2030-01-${String(index).padStart(2, "0")}T00-00-00-000Z.html`;
}

test("pruning keeps the newest report pages and nothing else is ever chosen", () => {
  expect(REPORT_FILES_KEPT).toBe(20);
  const names = Array.from({ length: 25 }, (_, index) => reportName(index + 1));
  const current = reportName(25);
  expect(reportFilesToPrune(entries(...names), current)).toEqual([5, 4, 3, 2, 1].map(reportName));
  expect(reportFilesToPrune(entries(...names.slice(0, 20)), reportName(20))).toEqual([]);

  const mixed: readonly ReportDirectoryEntry[] = [
    ...entries(reportName(1), reportName(2), reportName(3), "notes.html", "report-draft.txt"),
    { name: reportName(4), isFile: false },
  ];
  expect(reportFilesToPrune(mixed, reportName(3), 2)).toEqual([reportName(1)]);
  expect(reportFilesToPrune(entries(reportName(9), reportName(1)), reportName(1), 1)).toEqual([
    reportName(9),
  ]);
  expect(reportFilesToPrune(entries(reportName(2)), reportName(2), 0)).toEqual([]);
});

test("publish prunes old report files but leaves other files and symlinks alone", async () => {
  await withHome(async (home) => {
    const directory = join(home, "reports");
    await mkdir(directory, { recursive: true });
    const older = Array.from({ length: 22 }, (_, index) =>
      reportName(index + 1).replace("2030-01", "2029-12"),
    );
    for (const name of older) await writeFile(join(directory, name), "old");
    await writeFile(join(directory, "notes.txt"), "mine");
    const target = join(home, "elsewhere.html");
    await writeFile(target, "keep me");
    const link = "report-2000-01-01T00-00-00-000Z.html";
    await symlink(target, join(directory, link));

    const published = await publishReport({
      home,
      run: async () => {
        throw new Error("unexpected command");
      },
      view: VIEW,
      open: false,
    });
    const remaining = (await readdir(directory)).sort();
    const keptReports = remaining.filter(
      (name) => name.startsWith("report-") && name !== link && name !== basename(published.path),
    );
    expect(keptReports).toEqual(older.slice(-19));
    expect(remaining).toContain(basename(published.path));
    expect(remaining).toContain("notes.txt");
    expect(remaining).toContain(link);
    expect(await readFile(target, "utf8")).toBe("keep me");
  });
});

test("a directory named like a report page is never pruned", async () => {
  await withHome(async (home) => {
    const directory = join(home, "reports");
    await mkdir(join(directory, reportName(1)), { recursive: true });
    await writeFile(join(directory, reportName(1), "inner"), "x");
    for (let index = 2; index <= 21; index += 1) {
      await writeFile(join(directory, reportName(index)), "old");
    }
    const published = await publishReport({
      home,
      run: async () => {
        throw new Error("unexpected command");
      },
      view: { ...VIEW, generatedAt: "2031-01-01T00:00:00.000Z" },
      open: false,
    });
    expect(await readFile(published.path, "utf8")).toContain("<html");
    expect(await readdir(join(directory, reportName(1)))).toEqual(["inner"]);
    const remaining = await readdir(directory);
    expect(remaining).not.toContain(reportName(2));
    expect(remaining).toHaveLength(21);
  });
});

test("publish without opening writes the file and runs nothing", async () => {
  await withHome(async (home) => {
    const runner = recordingRunner(() => {
      throw new Error("unexpected command");
    });
    const published = await publishReport({ home, run: runner.run, view: VIEW, open: false });
    expect(published.opened).toBe(false);
    expect(published.openError).toBeUndefined();
    expect(runner.calls).toEqual([]);
    expect(await readFile(published.path, "utf8")).toContain("<html");
  });
});
