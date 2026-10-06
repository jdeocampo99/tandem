import { expect, test } from "bun:test";
import { nativeBriefFile } from "../../../src/board/native-views.ts";
import { nativeDetailPath, nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

for (const mode of [
  "closed",
  "missing",
  "coordinator",
  "wrong-request",
  "foreign-program",
  "busy",
  "changed",
  "unknown",
] as const) {
  test(`retiring a native brief: ${mode} closes only the exact idle originating split`, async () => {
    const home = "/tmp/native-brief-close-fixture";
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
    const args = [
      nativeDetailPath(home, home, nativeBriefFile("req-1")),
      "3",
      home,
      "",
      nativeViewsPath(home, home),
    ];
    let removed = mode === "missing";
    let processReads = 0;
    let closeCalls = 0;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
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
                  blocks: [
                    { id: "3", title: "Tandem brief", cwd: home, live: true },
                    ...(removed
                      ? []
                      : [
                          {
                            id: "4",
                            title: "Tandem brief",
                            cwd: home,
                            live: false,
                            program:
                              mode === "foreign-program" ? "unrelated.brief" : "tandem.brief",
                            args:
                              mode === "wrong-request" || (mode === "changed" && processReads > 0)
                                ? ["foreign.json", ...args.slice(1)]
                                : args,
                          },
                        ]),
                  ],
                },
              ],
            },
          ],
          detached: [],
        };
      else if (verb === "process") {
        processReads++;
        value = {
          pane: "4",
          child: mode === "busy" ? { pid: 10, name: "sh", argv: ["sh"], cwd: home } : null,
          foreground: null,
          group: null,
        };
      } else if (verb === "close") {
        closeCalls++;
        expect(request.argv[2]).toBe("4");
        removed = true;
        if (mode === "unknown") return { code: 1, stderr: "lost acknowledgment", stdout: "" };
        value = { block: "4" };
      } else throw new Error(`unexpected ${verb}`);
      return { code: 0, stderr: "", stdout: JSON.stringify(value) };
    };
    let quarantined = false;
    const host = ternViewHost(ternCommands(run, {}), {
      clock: Date.now,
      wait: Bun.sleep,
      guard: async (_key, operation) => {
        if (quarantined) throw new TernOutcomeUnknownError("brief close", "quarantined");
        try {
          return await operation();
        } catch (error) {
          if (error instanceof TernOutcomeUnknownError) quarantined = true;
          throw error;
        }
      },
    });
    const close = () =>
      host.close(
        {
          coordinator,
          cwd: home,
          home,
          view: { kind: "brief", requestId: "req-1" },
          origin: { paneId: mode === "coordinator" ? "3" : "4" },
        },
        home,
      );
    if (mode === "closed" || mode === "missing") {
      expect(await close()).toEqual({ closed: true, warnings: [] });
      expect(closeCalls).toBe(mode === "missing" ? 0 : 1);
    } else {
      await expect(close()).rejects.toThrow();
      expect(closeCalls).toBe(mode === "unknown" ? 1 : 0);
      if (mode === "unknown") {
        await expect(close()).rejects.toThrow("quarantine");
        expect(closeCalls).toBe(1);
      }
    }
  });
}
