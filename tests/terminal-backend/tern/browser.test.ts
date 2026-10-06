import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { openFiles } from "../../native/view-files.ts";

// A browser opening can never be proved or disproved later, and it is never re-invoked. A
// process that dies right after `tern browser`, or a reply that never proves the new browser,
// must not leave anything that pauses the user's next open.
for (const mode of ["failed-listing", "malformed-listing", "lost-ack", "confirmed"] as const) {
  test(`browser ${mode} is reported once and never pauses later opens`, async () => {
    const root = await realpath(await mkdtemp("/tmp/tandem-browser-"));
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
    const focuses: string[] = [];
    let loseListing = false;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "inspect")
        return { code: 0, stderr: "", stdout: JSON.stringify({ clients: [{ kind: "window" }] }) };
      if (verb === "focus") {
        focuses.push(request.argv[2] ?? "");
        return { code: 0, stderr: "", stdout: '{"block":"3"}' };
      }
      if (verb === "browser") {
        // A crash here leaves no durable record behind.
        expect((await openFiles(home)).filter((name) => name.endsWith(".ticket.json"))).toEqual([]);
        expect(JSON.parse(request.argv[2] ?? "")).toEqual({
          op: "open",
          owner: 3,
          url: "https://example.invalid/pull/281",
        });
        opens++;
        loseListing = mode.endsWith("-listing") && opens === 1;
        if (mode === "lost-ack" && opens === 1)
          return { code: 1, stderr: "lost browser acknowledgement", stdout: "" };
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ ok: { block: String(3 + opens) } }),
        };
      }
      if (verb !== "ls") throw new Error(`Unexpected browser proof command ${verb}`);
      if (loseListing) {
        loseListing = false;
        return mode === "malformed-listing"
          ? { code: 0, stdout: "malformed", stderr: "" }
          : { code: 1, stdout: "", stderr: "lost post-open snapshot" };
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
                    ...Array.from({ length: opens }, (_, index) => ({
                      id: String(4 + index),
                      title: "PR",
                      cwd: repo,
                      live: false,
                      program: "browser",
                    })),
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
      const open = (backend = terminal) =>
        backend.openView({
          coordinator,
          cwd: repo,
          home,
          origin: { paneId: "3", cwd: repo },
          view: { kind: "browser", url: "https://example.invalid/pull/281" },
        });
      const tickets = async () =>
        (await openFiles(home)).filter((name) => name.endsWith(".ticket.json"));
      if (mode === "confirmed") {
        expect(await open()).toEqual({ opened: true, warnings: [] });
        expect(await tickets()).toEqual([]);
        expect(opens).toBe(1);
        return;
      }
      await expect(open()).rejects.toThrow(
        "Tern did not confirm the PR opened in its browser. Tandem did not retry",
      );
      expect(opens).toBe(1);
      expect(await tickets()).toEqual([]);
      expect(focuses).toEqual([]);
      // The user's next click is a new opening, in this process or a fresh one.
      expect(await open()).toEqual({ opened: true, warnings: [] });
      expect(await open(ternBackend(run, { home, binary: "tern" }))).toEqual({
        opened: true,
        warnings: [],
      });
      expect(opens).toBe(3);
      expect(await tickets()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
