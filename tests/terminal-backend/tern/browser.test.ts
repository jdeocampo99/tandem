import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

// Regression from the #282 safety verifier's browser-relaunch.test.ts:
// independent native CLI backends must not repeat the same uncertain opening.
for (const mode of ["failed-listing", "malformed-listing", "lost-ack", "confirmed"] as const) {
  test(`browser ${mode} persists quarantine across fresh backend instances`, async () => {
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
    let loseListing = false;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "inspect")
        return { code: 0, stderr: "", stdout: JSON.stringify({ clients: [{ kind: "window" }] }) };
      if (verb === "browser") {
        const intents = (await readdir(join(home, "native-host"))).filter((name) =>
          name.endsWith(".intent.json"),
        );
        expect(intents).toHaveLength(1);
        const path = join(home, "native-host", intents[0] ?? "");
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(path, "utf8")).browser.url).toBe(
          "https://example.invalid/pull/281",
        );
        expect(JSON.parse(request.argv[2] ?? "")).toEqual({
          op: "open",
          owner: 3,
          url: "https://example.invalid/pull/281",
        });
        opens++;
        loseListing = mode !== "confirmed";
        if (mode === "lost-ack")
          return { code: 1, stderr: "lost browser acknowledgement", stdout: "" };
        return { code: 0, stderr: "", stdout: '{"ok":{"block":"4"}}' };
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
      const open = (backend = terminal) =>
        backend.openView({
          coordinator,
          cwd: repo,
          home,
          origin: { paneId: "3", cwd: repo },
          view: { kind: "browser", url: "https://example.invalid/pull/281" },
        });
      if (mode === "confirmed") {
        expect(await open()).toEqual({ opened: true, warnings: [] });
        expect(
          (await readdir(join(home, "native-host"))).filter((name) =>
            name.endsWith(".intent.json"),
          ),
        ).toHaveLength(0);
      } else {
        await expect(open()).rejects.toThrow("outcome is unknown");
        loseListing = false;
        await expect(open(ternBackend(run, { home, binary: "tern" }))).rejects.toThrow(
          "quarantine",
        );
        await expect(open()).rejects.toThrow("quarantine");
        // Reads now succeed and the created browser is visible, but they cannot
        // prove the URL/owner of an earlier uncertain operation.
        loseListing = false;
        await expect(open(ternBackend(run, { home, binary: "tern" }))).rejects.toThrow(
          "outcome is unknown",
        );
        await expect(
          ternBackend(run, { home, binary: "tern" }).openPanel({
            coordinator,
            cwd: repo,
            project: repo,
          }),
        ).rejects.toThrow("outcome is unknown");
        expect(
          (await readdir(join(home, "native-host"))).filter((name) =>
            name.endsWith(".intent.json"),
          ),
        ).toHaveLength(1);
      }
      expect(opens).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
