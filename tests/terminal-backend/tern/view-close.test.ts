import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { nativeBriefFile } from "../../../src/board/native-views.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { blockArgs } from "../../../src/native/contract.ts";
import { viewDetailPath, viewIndexPath } from "../../../src/native/store.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { openFiles } from "../../native/view-files.ts";

for (const mode of [
  "closed",
  "missing",
  "coordinator",
  "wrong-request",
  "foreign-program",
  "busy",
  "changed",
  "removed-after-idle-read",
  "program-after-idle-read",
  "args-after-idle-read",
  "tab-after-idle-read",
  "unknown",
] as const) {
  test(`retiring a native brief: ${mode} closes only the exact idle originating split`, async () => {
    const home = await mkdtemp("/tmp/native-brief-close-");
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
    const args = blockArgs(viewDetailPath(home, home, nativeBriefFile("req-1")), {
      coordinator: "3",
      cwd: home,
      home,
      index: viewIndexPath(home, home),
    });
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
                    ...(removed || (mode === "tab-after-idle-read" && processReads === 1)
                      ? []
                      : [
                          {
                            id: "4",
                            title: "Tandem brief",
                            cwd: home,
                            live: false,
                            program:
                              mode === "foreign-program" ||
                              (mode === "program-after-idle-read" && processReads === 1)
                                ? "unrelated.brief"
                                : "tandem.brief",
                            args:
                              mode === "wrong-request" ||
                              (mode === "changed" && processReads > 0) ||
                              (mode === "args-after-idle-read" && processReads === 1)
                                ? ["/foreign.json", args[1], args[2]]
                                : args,
                          },
                        ]),
                  ],
                },
                ...(mode === "tab-after-idle-read" && processReads === 1
                  ? [
                      {
                        id: "5",
                        name: null,
                        blocks: [
                          {
                            id: "4",
                            title: "Tandem brief",
                            cwd: home,
                            live: false,
                            program: "tandem.brief",
                            args,
                          },
                        ],
                      },
                    ]
                  : []),
              ],
            },
          ],
          detached: [],
        };
      else if (verb === "process") {
        processReads++;
        if (processReads === 1 && mode === "removed-after-idle-read") removed = true;
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
    const close = () =>
      ternViewHost(ternCli(run)).close(
        {
          coordinator,
          cwd: home,
          home,
          view: { kind: "brief", requestId: "req-1" },
          origin: { paneId: mode === "coordinator" ? "3" : "4" },
        },
        home,
      );
    try {
      if (mode === "closed" || mode === "missing") {
        expect(await close()).toEqual({ closed: true, warnings: [] });
        expect(closeCalls).toBe(mode === "missing" ? 0 : 1);
      } else {
        await expect(close()).rejects.toThrow();
        expect(closeCalls).toBe(mode === "unknown" ? 1 : 0);
        if (mode === "unknown") {
          // The brief is now absent from an exact listing, so a later click finds it closed
          // without repeating the close.
          expect(await close()).toEqual({ closed: true, warnings: [] });
          expect(closeCalls).toBe(1);
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

for (const kind of ["board"] as const) {
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
    test(`retiring a native ${kind}: ${mode} closes only the exact idle originating view`, async () => {
      const home = await mkdtemp("/tmp/native-board-return-");
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
      const args = blockArgs(viewIndexPath(home, home), {
        coordinator: "3",
        cwd: home,
        home,
        index: viewIndexPath(home, home),
      });
      let removed = mode === "missing";
      let processReads = 0;
      let closeCalls = 0;
      const run: CommandRunner = async (request) => {
        expect(request.argv).toContain("active-window");
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
                                mode === "foreign-program" ? "unrelated.brief" : `tandem.${kind}`,
                              args:
                                mode === "wrong-request" || (mode === "changed" && processReads > 0)
                                  ? ["/foreign.json", args[1], args[2]]
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
        } else if (verb === "focus") value = { block: "3" };
        else if (verb === "open") {
          const ticket = JSON.parse(await readFile(request.argv[2] ?? "", "utf8"));
          expect(ticket.placement).toBe("return");
          if (ticket.closeOrigin !== undefined) {
            expect(ticket.closeOrigin).toBe("4");
            closeCalls++;
            removed = true;
          }
          if (mode === "unknown") return { code: 1, stderr: "lost acknowledgment", stdout: "" };
          await writeFile(
            ticket.receipt,
            JSON.stringify({ status: "done", paneId: "3", tabId: "2", sessionId: "1" }),
          );
          return { code: 1, stderr: "cannot open in a file block", stdout: "" };
        } else throw new Error(`unexpected ${verb}`);
        return { code: 0, stderr: "", stdout: JSON.stringify(value) };
      };
      const close = () =>
        ternViewHost(ternCli(run, { wait: async () => {} })).open(
          {
            coordinator,
            cwd: home,
            home,
            view: { kind: "orchestrator" },
            origin: { paneId: mode === "coordinator" ? "3" : "4", windowId: "active-window" },
          },
          home,
          "panel",
          "return",
          viewIndexPath(home, home),
        );
      try {
        if (mode === "closed" || mode === "coordinator") {
          expect(await close()).toEqual({ paneId: "3", project: home });
          expect(closeCalls).toBe(mode === "coordinator" ? 0 : 1);
        } else {
          await expect(close()).rejects.toThrow();
          expect(closeCalls).toBe(mode === "unknown" ? 1 : 0);
          if (mode === "unknown") {
            expect((await openFiles(home)).some((name) => name.endsWith(".ticket.json"))).toBe(
              true,
            );
            const returned = await close();
            expect(returned.warnings?.[0]).toContain("recovery record were kept");
            expect(closeCalls).toBe(1);
            expect((await openFiles(home)).some((name) => name.endsWith(".ticket.json"))).toBe(
              true,
            );
          }
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
}
