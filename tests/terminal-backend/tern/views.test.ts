import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

const endpoint: Endpoint = {
  terminal: "tern",
  sessionId: "test",
  terminalSessionId: "1",
  workspaceId: "2",
  tabId: "2",
  paneId: "3",
  role: "coordinator",
  generation: 0,
};
for (const mode of [
  "success",
  "wrong-kind",
  "multiple-windows",
  "missing-origin",
  "unknown",
] as const)
  test(`native opening ${mode} retains exact identity and never falls back to a title`, async () => {
    const home = await mkdtemp("/tmp/tandem-host-test-");
    let created = false;
    let effects = 0;
    let now = 0;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "inspect")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            clients: Array.from({ length: mode === "multiple-windows" ? 2 : 1 }, () => ({
              kind: "window",
            })),
          }),
        };
      if (verb === "ls")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            sessions: [
              {
                id: 1,
                name: "fixture",
                tabs: [
                  {
                    id: 2,
                    name: null,
                    blocks: [
                      { id: 3, title: "Tandem panel", cwd: home, live: true, cols: 150 },
                      ...(created
                        ? [
                            {
                              id: 4,
                              title: "Tandem panel",
                              cwd: home,
                              live: true,
                              program: mode === "wrong-kind" ? "unrelated.panel" : "tandem.panel",
                              args: [home + "/index.json", "3", home, "", home],
                            },
                          ]
                        : []),
                    ],
                  },
                ],
              },
            ],
            detached: [],
          }),
        };
      effects++;
      if (verb === "focus") return { code: 0, stderr: "", stdout: '{"block":3}' };
      if (verb === "open") {
        const path = request.argv[2];
        if (!path) throw new Error("missing route");
        const ticket = JSON.parse(await readFile(path, "utf8"));
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect(ticket.args).toEqual([home + "/index.json", "3", home, "", home]);
        created = true;
        if (mode !== "unknown")
          await writeFile(
            ticket.receipt,
            JSON.stringify({ paneId: "4", tabId: "2", sessionId: "1" }),
          );
        return { code: 1, stderr: "cannot open in a file block", stdout: "" };
      }
      throw new Error(`unexpected ${verb}`);
    };
    const quarantined = new Set<string>();
    const host = ternViewHost(ternCommands(run, {}), {
      clock: () => now,
      wait: async (ms) => {
        now += ms;
      },
      guard: async (key, operation) => {
        if (quarantined.has(key)) throw new TernOutcomeUnknownError(key, "quarantined");
        try {
          return await operation();
        } catch (error) {
          if (error instanceof TernOutcomeUnknownError) quarantined.add(key);
          throw error;
        }
      },
    });
    const open = () =>
      host.open(
        {
          coordinator: endpoint,
          cwd: home,
          home,
          view: { kind: "board" },
          ...(mode === "missing-origin" ? { origin: { paneId: "99" } } : {}),
        },
        home,
        "panel",
        "panel",
        home + "/index.json",
      );
    try {
      if (mode === "success") expect(await open()).toEqual({ paneId: "4", project: home });
      else {
        await expect(open()).rejects.toThrow();
        if (mode === "unknown" || mode === "wrong-kind") {
          const before = effects;
          await expect(open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(effects).toBe(before);
          expect(created).toBe(true);
        } else expect(effects).toBe(0);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
