import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

test("a browser open with a lost post-effect listing is quarantined without another opening", async () => {
  const root = await mkdtemp("/tmp/tandem-browser-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(repo)]);
  const coordinator: Endpoint = {
    terminal: "tern",
    sessionId: "test",
    terminalSessionId: "1",
    workspaceId: "2",
    tabId: "2",
    paneId: "3",
    role: "coordinator",
    generation: 0,
  };
  let opens = 0;
  let loseListing = false;
  const run: CommandRunner = async (request) => {
    const verb = request.argv[1];
    if (verb === "inspect")
      return { code: 0, stderr: "", stdout: JSON.stringify({ clients: [{ kind: "window" }] }) };
    if (verb === "browser") {
      expect(JSON.parse(request.argv[2] ?? "")).toEqual({
        op: "open",
        owner: 3,
        url: "https://example.invalid/pull/281",
      });
      opens++;
      loseListing = true;
      return { code: 0, stderr: "", stdout: '{"ok":{"block":"4"}}' };
    }
    if (verb !== "ls") throw new Error(`Unexpected browser proof command ${verb}`);
    if (loseListing) {
      loseListing = false;
      return { code: 1, stdout: "", stderr: "lost post-open snapshot" };
    }
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        sessions: [
          {
            id: "1",
            name: "fixture",
            tabs: [
              {
                id: "2",
                name: null,
                blocks: [
                  { id: "3", title: "Coordinator", cwd: repo, live: true },
                  ...(opens > 0
                    ? [{ id: "4", title: "PR", cwd: repo, live: false, program: "browser" }]
                    : []),
                ],
              },
            ],
          },
        ],
        detached: [],
      }),
    };
  };
  try {
    await saveCoordinatorRecord(home, {
      schemaVersion: 1,
      repoPath: repo,
      endpoint: coordinator,
      command: ["omp"],
      harness: DEFAULT_HARNESS,
      worktree: {
        root,
        path: repo,
        name: "fixture",
        branch: "fixture",
        baseHead: "a".repeat(40),
        leaseId: "fixture-lease",
        leaseHolder: "fixture",
        leasedAt: "2030-01-02T12:00:00Z",
      },
    });
    const terminal = ternBackend(run, { home, binary: "tern" });
    const open = () =>
      terminal.openView({
        coordinator,
        cwd: repo,
        home,
        origin: { paneId: "3", cwd: repo },
        view: { kind: "browser", url: "https://example.invalid/pull/281" },
      });
    await expect(open()).rejects.toThrow("outcome is unknown");
    await expect(open()).rejects.toThrow("quarantine");
    expect(opens).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
