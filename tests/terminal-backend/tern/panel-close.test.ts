import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { TernOutcomeUnknownError } from "../../../src/terminal-backend/tern/protocol.ts";

// Regressions from the #282 safety verifier's panel-probe.ts. Supply a real
// private coordinator record so refused ownership cannot mask post-effect failures.
for (const mode of [
  "failed",
  "malformed",
  "detached-after-close",
  "still-present",
  "confirmed",
  "retired-coordinator",
  "conversation",
  "missing",
  "detached-before-close",
  "foreign-before-close",
  "foreign-after-idle",
  "args-after-idle",
  "wrong-file",
  "wrong-owner",
  "wrong-cwd",
  "wrong-window",
  "wrong-index",
  "extra-arg",
  "no-record",
  "no-home",
  "wrong-tab-after-idle",
] as const) {
  test(`panel close ${mode} requires full recorded identity and fences uncertain effects`, async () => {
    const root = await realpath(await mkdtemp("/tmp/tandem-panel-close-"));
    const home = join(root, "home"),
      cwd = join(root, "repo");
    await Promise.all([mkdir(home), mkdir(cwd)]);
    const coordinator: Endpoint = {
      terminal: "tern",
      sessionId: "fixture",
      terminalSessionId: "1",
      workspaceId: "2",
      tabId: "2",
      paneId: mode === "conversation" ? "4" : "3",
      role: "coordinator",
      generation: 0,
    };
    const path = nativeViewsPath(home, cwd);
    const args = [path, coordinator.paneId, cwd, "", path];
    if (mode === "wrong-file") args[0] = "foreign.json";
    if (mode === "wrong-owner") args[1] = "5";
    if (mode === "wrong-cwd") args[2] = root;
    if (mode === "wrong-window") args[3] = "foreign-window";
    if (mode === "wrong-index") args[4] = "foreign.json";
    if (mode === "extra-arg") args.push("foreign");
    let closes = 0,
      readsAfterClose = 0,
      idleRead = false;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "close") {
        closes++;
        expect(request.argv[2]).toBe("4");
        return { code: 0, stderr: "", stdout: '{"block":"4"}' };
      }
      if (verb === "process") {
        idleRead = true;
        return {
          code: 0,
          stderr: "",
          stdout: '{"pane":"4","child":null,"foreground":null,"group":null}',
        };
      }
      if (verb !== "ls") throw new Error(`Unexpected panel proof command ${verb}`);
      if (closes > 0 && readsAfterClose++ === 0) {
        if (mode === "failed") return { code: 1, stderr: "lost close snapshot", stdout: "" };
        if (mode === "malformed") return { code: 0, stderr: "", stdout: "malformed" };
      }
      const panel = {
        id: "4",
        title: "Tandem panel",
        cwd,
        live: false,
        program:
          mode === "foreign-before-close" || (mode === "foreign-after-idle" && idleRead)
            ? "foreign.program"
            : "tandem.panel",
        args: mode === "args-after-idle" && idleRead ? [] : args,
      };
      const hidden =
        mode === "missing" ||
        mode === "detached-before-close" ||
        (closes > 0 && (mode === "confirmed" || mode === "retired-coordinator"));
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
                  id: mode === "wrong-tab-after-idle" && idleRead ? "5" : "2",
                  name: null,
                  blocks: [
                    ...(mode === "retired-coordinator" || mode === "conversation"
                      ? []
                      : [{ id: "3", title: "Coordinator", cwd, live: true }]),
                    // A visible panel on retry would be closed twice by the unfenced host.
                    ...(hidden ? [] : [panel]),
                  ],
                },
              ],
            },
          ],
          detached:
            mode === "detached-before-close" || (closes > 0 && mode === "detached-after-close")
              ? [panel]
              : [],
        }),
      };
    };
    try {
      if (mode !== "no-record")
        await saveCoordinatorRecord(home, {
          schemaVersion: 1,
          repoPath: cwd,
          endpoint: coordinator,
          harness: DEFAULT_HARNESS,
          command: ["omp"],
          worktree: {
            root,
            path: cwd,
            name: "fixture",
            branch: "fixture",
            baseHead: "a".repeat(40),
            leaseId: "fixture",
            leaseHolder: "fixture",
            leasedAt: "2030-01-02T12:00:00Z",
          },
        });
      const terminal = ternBackend(run, {
        binary: "tern",
        ...(mode === "no-home" ? {} : { home }),
      });
      const close = () => terminal.closePanel({ sessionId: "fixture", cwd, panelPaneId: "4" });
      const effectUnconfirmed = [
        "failed",
        "malformed",
        "detached-after-close",
        "still-present",
      ].includes(mode);
      if (mode === "confirmed" || mode === "retired-coordinator" || mode === "missing")
        await close();
      else if (effectUnconfirmed || mode === "detached-before-close") {
        await expect(close()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
        await expect(close()).rejects.toThrow("quarantine");
      } else {
        await expect(close()).rejects.toThrow();
        await expect(close()).rejects.toThrow();
      }
      expect(closes).toBe(
        effectUnconfirmed || mode === "confirmed" || mode === "retired-coordinator" ? 1 : 0,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
