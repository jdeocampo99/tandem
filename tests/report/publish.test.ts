import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { buildReportView } from "../../src/report/build.ts";
import { publishReport, reportFileName } from "../../src/report/publish.ts";

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
    expect(thrown.opened).toBe(false);
    expect(thrown.openError).toContain("ENOENT");
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
      openError: "Lavish reported error",
    });
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
