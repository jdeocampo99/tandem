import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

for (const mode of [
  "closed",
  "toggle",
  "wrong-args",
  "busy",
  "retained",
  "listing-failed",
] as const) {
  test(`full-window Back ${mode}: restore the exact coordinator and verify originating view closure`, async () => {
    const home = await mkdtemp("/tmp/tandem-window-return-");
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
    const path = nativeViewsPath(home, home);
    let removed = false;
    let opened = 0;
    let quarantined = false;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "ls" && mode === "listing-failed" && opened > 0)
        return { code: 1, stderr: "lost scoped snapshot", stdout: "" };
      let value: unknown;
      if (verb === "inspect") value = { clients: [{ kind: "window" }] };
      else if (verb === "ls")
        value = {
          sessions: [
            {
              id: "1",
              name: "fixture",
              tabs: [
                {
                  id: "2",
                  name: null,
                  blocks: [{ id: "3", title: "Board", cwd: home, live: true }],
                },
                ...(removed
                  ? []
                  : [
                      {
                        id: "5",
                        name: null,
                        blocks: [
                          {
                            id: "4",
                            title: "Board",
                            cwd: home,
                            live: false,
                            program: "tandem.board",
                            args: [path, "3", mode === "wrong-args" ? "/foreign" : home, "", path],
                          },
                        ],
                      },
                    ]),
              ],
            },
          ],
          detached: [],
        };
      else if (verb === "process")
        value = {
          pane: "4",
          child: mode === "busy" ? { pid: 10, name: "sh", argv: ["sh"], cwd: home } : null,
          foreground: null,
          group: null,
        };
      else if (verb === "focus") value = { block: "3" };
      else if (verb === "open") {
        opened++;
        const ticket = JSON.parse(await readFile(request.argv[2] ?? "", "utf8"));
        expect(ticket.closeOrigin).toBe("4");
        expect(ticket.placement).toBe("return");

        removed = mode !== "retained";
        await writeFile(
          ticket.receipt,
          JSON.stringify({ paneId: "3", tabId: "2", sessionId: "1" }),
        );
        return { code: 1, stderr: "cannot open in a file block", stdout: "" };
      } else throw new Error(`unexpected ${verb}`);
      return { code: 0, stderr: "", stdout: JSON.stringify(value) };
    };
    const host = ternViewHost(ternCommands(run, {}), {
      clock: Date.now,
      wait: async () => {},
      guard: async (_key, operation) => {
        if (quarantined) throw new TernOutcomeUnknownError("return", "quarantined");
        try {
          return await operation();
        } catch (error) {
          if (error instanceof TernOutcomeUnknownError) quarantined = true;
          throw error;
        }
      },
    });
    const back = () =>
      mode === "toggle"
        ? host.toggleBoard(
            {
              coordinator,
              cwd: home,
              home,
              origin: { paneId: "4", windowId: "active-window" },
              view: { kind: "board" },
            },
            home,
          )
        : host.open(
            {
              coordinator,
              cwd: home,
              home,
              origin: { paneId: "4", windowId: "active-window" },
              view: { kind: "orchestrator" },
            },
            home,
            "panel",
            "return",
            path,
          );
    try {
      if (mode === "toggle") expect(await back()).toBe(true);
      else if (mode === "closed") expect(await back()).toEqual({ paneId: "3", project: home });
      else await expect(back()).rejects.toThrow();
      expect(opened).toBe(
        mode === "closed" || mode === "toggle" || mode === "retained" || mode === "listing-failed"
          ? 1
          : 0,
      );
      if (mode === "listing-failed") {
        expect(quarantined).toBe(true);
        await expect(back()).rejects.toThrow();
        expect(opened).toBe(1);
      }
      if (mode === "retained") {
        await expect(back()).rejects.toThrow("quarantine");
        expect(opened).toBe(1);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
