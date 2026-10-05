import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import {
  isCoordinatorPanel,
  openPanelBeside,
  readPanelPaneId,
} from "../../src/coordinator/panel.ts";
import type { CoordinatorRecord } from "../../src/coordinator/record.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import {
  discoverCoordinatorRecords,
  readCoordinatorRecord,
  saveCoordinatorRecord,
} from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";

async function fixture(): Promise<{ root: string; home: string; record: CoordinatorRecord }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-panel-")));
  const home = join(root, "home");
  const repoPath = join(root, "repo");
  const worktree = join(root, "pool", "coordinator-a");
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktree, { recursive: true });
  const record: CoordinatorRecord = {
    schemaVersion: 1,
    repoPath,
    endpoint: {
      sessionId: "tandem",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      role: "coordinator",
      generation: 0,
    },
    worktree: {
      root: join(root, "pool"),
      path: worktree,
      name: "coordinator-a",
      baseHead: "abc123",
      branch: "tandem/coordinator-a",
      leaseId: "lease-a",
      leaseHolder: "coordinator-a",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    harness: DEFAULT_HARNESS,
    command: ["omp"],
  };
  return { root, home, record };
}

function ok(result: unknown): CommandResult {
  return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
}

test("opens the panel right of the coordinator and records it", async () => {
  const { root, home, record } = await fixture();
  try {
    await saveCoordinatorRecord(home, record);
    const calls: CommandRequest[] = [];
    const run = async (request: CommandRequest): Promise<CommandResult> => {
      calls.push(request);
      const command = request.argv.slice(3).join(" ");
      if (command.startsWith("plugin pane open")) {
        return ok({ plugin_pane: { pane: { pane_id: "w1:p2" }, plugin_id: "tandem.ui" } });
      }
      throw new Error(`unexpected ${command}`);
    };

    expect(await openPanelBeside(run, home, record)).toBeUndefined();

    expect(calls.map((call) => call.argv.slice(3))).toEqual([
      [
        "plugin",
        "pane",
        "open",
        "--plugin",
        "tandem.ui",
        "--entrypoint",
        "panel",
        "--placement",
        "split",
        "--target-pane",
        "w1:p1",
        "--direction",
        "right",
        "--no-focus",
        "--env",
        `TANDEM_PANEL_PROJECT=${record.repoPath}`,
      ],
    ]);
    expect(await readPanelPaneId(home, record)).toBe("w1:p2");
    // The record stays exactly what a Tandem without the panel reads, and the panel file is
    // not mistaken for a record.
    const saved = await readCoordinatorRecord(recordPath(home, "tandem", record.repoPath));
    expect(saved).toEqual(record);
    const discovered = await discoverCoordinatorRecords({ home });
    expect(discovered.records.map((entry) => entry.record)).toEqual([record]);
    expect(discovered.unreadable).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a pane in the coordinator's workspace with the panel's title counts as its panel", () => {
  const pane = (fields: Record<string, unknown>) => ({
    result: { pane: { pane_id: "w1:p2", workspace_id: "w1", label: "Tandem panel", ...fields } },
  });
  expect(isCoordinatorPanel(pane({}), "w1", "w1:p2")).toBe(true);
  expect(isCoordinatorPanel(pane({ workspace_id: "w2" }), "w1", "w1:p2")).toBe(false);
  expect(isCoordinatorPanel(pane({ label: "notes" }), "w1", "w1:p2")).toBe(false);
  expect(isCoordinatorPanel(pane({ pane_id: "w1:p3" }), "w1", "w1:p2")).toBe(false);
});

const notFound = (code: string): CommandResult => ({
  code: 1,
  stdout: "",
  stderr: JSON.stringify({ error: { code } }),
});

test("keeps a recorded panel that is still open, and reports a failed open without throwing", async () => {
  const { root, home, record } = await fixture();
  try {
    await openPanelBeside(
      async (request) =>
        request.argv[3] === "plugin" ? ok({ plugin_pane: { pane: { pane_id: "w1:p2" } } }) : ok({}),
      home,
      record,
    );
    const calls: string[] = [];
    const stillOpen = await openPanelBeside(
      async (request) => {
        calls.push(request.argv.slice(3).join(" "));
        return ok({ pane: { pane_id: "w1:p2", workspace_id: "w1", label: "Tandem panel" } });
      },
      home,
      record,
    );
    expect(stillOpen).toBeUndefined();
    expect(calls).toEqual(["pane get w1:p2"]);

    const failure = await openPanelBeside(
      async (request) =>
        request.argv[4] === "get" ? notFound("pane_not_found") : notFound("plugin_not_found"),
      home,
      record,
    );
    expect(failure).toContain("herdr plugin pane open");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable panel file counts as no recorded panel", async () => {
  const { root, home, record } = await fixture();
  try {
    await saveCoordinatorRecord(home, record);
    const file = recordPath(home, "tandem", record.repoPath).replace(/\.json$/u, ".panel");
    await writeFile(file, "{not json");
    expect(await readPanelPaneId(home, record)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
