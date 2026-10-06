import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { AdapterCommandError, AdapterProtocolError } from "../../../src/adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { blockArgs } from "../../../src/native/contract.ts";
import { viewIndexPath } from "../../../src/native/store.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { TernOutcomeUnknownError } from "../../../src/terminal-backend/tern/protocol.ts";
import { detailForView, ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { openFiles } from "../../native/view-files.ts";

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
  "brief-success",
  "brief-unknown",
  "pr-success",
  "pr-unknown",
  "prs-success",
  "task-picker-success",
  "verification-failed",
  "verification-malformed",
  "relaunch-success",
  "relaunch-detached",
  "relaunch-other-window",
  "relaunch-other-window-args",
  "relaunch-other-session",
  "pre-focus-read-failed",
  "pre-focus-malformed",
  "focus-unknown",
  "relaunch-missing-receipt",
  "relaunch-no-exact-pane",
  "duplicate-panels",
  "wrong-placement",
  "wrong-kind",
  "multiple-windows",
  "missing-origin",
  "unknown",
  "foreign-return",
  "unsafe-id",
] as const)
  test(`native opening ${mode} keeps exact identity and never falls back to a title`, async () => {
    const home = await mkdtemp("/tmp/tandem-host-test-");
    const modelPath = viewIndexPath(home, home);
    const argsFor = (coordinator = "3", window?: string) =>
      blockArgs(modelPath, {
        coordinator,
        cwd: home,
        home,
        index: modelPath,
        ...(window === undefined ? {} : { window }),
      });
    const tickets = async () =>
      (await openFiles(home)).filter((name) => name.endsWith(".ticket.json"));
    const splitKind = mode.startsWith("brief-")
      ? "brief"
      : mode.startsWith("pr-")
        ? "pr"
        : mode === "prs-success"
          ? "prs"
          : mode === "task-picker-success"
            ? "task-picker"
            : undefined;
    let created = false;
    let effects = 0;
    let now = 0;
    let failVerification = true;
    let routePath = "";
    let moved = false;
    let listingReads = 0;
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
      if (verb === "ls") {
        listingReads++;
        if (
          listingReads === 4 &&
          (mode === "pre-focus-read-failed" || mode === "pre-focus-malformed")
        )
          return {
            code: mode === "pre-focus-read-failed" ? 1 : 0,
            stderr: "injected pre-focus read failure",
            stdout: "malformed",
          };
        const hidden =
          moved &&
          (mode === "relaunch-detached" ||
            mode === "relaunch-other-session" ||
            (mode.startsWith("relaunch-other-window") && request.argv.includes("--window")));
        if (
          created &&
          failVerification &&
          (mode === "verification-failed" || mode === "verification-malformed")
        ) {
          failVerification = false;
          return {
            code: mode === "verification-failed" ? 1 : 0,
            stderr: "injected listing failure",
            stdout: "malformed",
          };
        }
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
                      ...((created && !hidden) ||
                      mode === "foreign-return" ||
                      mode === "duplicate-panels"
                        ? [
                            {
                              id: 4,
                              title: "Tandem panel",
                              cwd: home,
                              live: true,
                              program:
                                mode === "foreign-return"
                                  ? "tandem.task"
                                  : mode === "wrong-kind"
                                    ? "unrelated.panel"
                                    : splitKind !== undefined
                                      ? `tandem.${splitKind}`
                                      : "tandem.panel",
                              args: argsFor(
                                mode === "foreign-return" ? "999" : "3",
                                moved && mode === "relaunch-other-window-args"
                                  ? "another-window"
                                  : undefined,
                              ),
                            },
                          ]
                        : []),
                      ...(mode === "duplicate-panels"
                        ? [
                            {
                              id: 5,
                              title: "Duplicate",
                              cwd: home,
                              live: true,
                              program: "tandem.panel",
                              args: argsFor(),
                            },
                          ]
                        : []),
                    ],
                  },
                  ...(created && mode === "wrong-placement"
                    ? [
                        {
                          id: 6,
                          name: null,
                          blocks: [
                            {
                              id: 7,
                              title: "foreign tab",
                              cwd: home,
                              live: true,
                              program: "tandem.panel",
                              args: argsFor(),
                            },
                          ],
                        },
                      ]
                    : []),
                ],
              },
              ...(moved && mode === "relaunch-other-session"
                ? [
                    {
                      id: 6,
                      name: "other session",
                      tabs: [
                        {
                          id: 7,
                          name: null,
                          blocks: [
                            {
                              id: 4,
                              title: "Tandem panel",
                              cwd: home,
                              live: true,
                              program: "tandem.panel",
                              args: argsFor(),
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : []),
            ],
            detached:
              moved && mode === "relaunch-detached"
                ? [
                    {
                      id: 4,
                      title: "Tandem panel",
                      cwd: home,
                      live: true,
                      program: "tandem.panel",
                      args: argsFor(),
                    },
                  ]
                : [],
          }),
        };
      }
      effects++;
      if (verb === "focus") {
        if (mode === "focus-unknown")
          return { code: 1, stderr: "lost focus acknowledgement", stdout: "" };
        return { code: 0, stderr: "", stdout: JSON.stringify({ block: request.argv[2] }) };
      }
      if (verb === "open") {
        const path = request.argv[2];
        if (!path) throw new Error("missing route");
        routePath = path;
        const ticket = JSON.parse(await readFile(path, "utf8"));
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect(ticket.args).toEqual(argsFor());
        created = true;
        if (
          ![
            "unknown",
            "brief-unknown",
            "pr-unknown",
            "relaunch-missing-receipt",
            "relaunch-no-exact-pane",
          ].includes(mode)
        )
          await writeFile(
            ticket.receipt,
            JSON.stringify({ status: "done", paneId: "4", tabId: "2", sessionId: "1" }),
          );
        return { code: 1, stderr: "cannot open in a file block", stdout: "" };
      }
      throw new Error(`unexpected ${verb}`);
    };
    const host = ternViewHost(
      ternCli(run, {
        clock: () => now,
        wait: async (ms) => {
          now += ms;
        },
      }),
    );
    const open = () =>
      host.open(
        {
          coordinator:
            mode === "unsafe-id" ? { ...endpoint, paneId: "9007199254740993" } : endpoint,
          cwd: home,
          home,
          view: { kind: "board" },
          ...(mode === "missing-origin"
            ? { origin: { paneId: "99" } }
            : mode === "foreign-return"
              ? { origin: { paneId: "4" } }
              : {}),
        },
        home,
        splitKind ?? "panel",
        splitKind !== undefined ? "split" : mode === "foreign-return" ? "return" : "panel",
        modelPath,
      );
    try {
      if (mode.startsWith("relaunch-")) {
        const fresh = () =>
          ternBackend(run, {
            home,
            ...(mode.startsWith("relaunch-other-window") ? { windowKey: "owned-window" } : {}),
            clock: () => now,
            wait: async (ms) => {
              now += ms;
            },
          });
        const input = { coordinator: endpoint, cwd: home, project: home };
        const first = fresh();
        if (
          mode === "relaunch-success" ||
          mode === "relaunch-detached" ||
          mode.startsWith("relaunch-other-")
        ) {
          expect(await first.openPanel(input)).toBe("4");
          moved = mode !== "relaunch-success";
        } else {
          await expect(first.openPanel(input)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(await tickets()).toHaveLength(1);
          if (mode === "relaunch-no-exact-pane") created = false;
        }
        const before = effects;
        if (mode === "relaunch-detached" || mode.startsWith("relaunch-other-")) {
          await expect(fresh().openPanel(input)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(created).toBe(true);
          expect((await openFiles(home)).filter((name) => !name.endsWith(".lock"))).toEqual([]);
        } else if (mode === "relaunch-no-exact-pane" || mode === "relaunch-missing-receipt") {
          // A route Tern never answered stays retained whatever the listing shows.
          await expect(fresh().openPanel(input)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(await Bun.file(routePath).exists()).toBe(true);
        } else {
          expect(await fresh().openPanel(input)).toBe("4");
          expect((await openFiles(home)).filter((name) => !name.endsWith(".lock"))).toEqual([]);
        }
        expect(effects).toBe(before);
      } else if (
        mode === "pre-focus-read-failed" ||
        mode === "pre-focus-malformed" ||
        mode === "focus-unknown"
      ) {
        const backend = () =>
          ternBackend(run, {
            home,
            clock: () => now,
            wait: async (ms) => {
              now += ms;
            },
          });
        const first = backend();
        const input = { coordinator: endpoint, cwd: home, project: home };
        if (mode === "focus-unknown") {
          await expect(first.openPanel(input)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(effects).toBe(1);
          await expect(backend().openPanel(input)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          expect(effects).toBe(1);
          expect(await tickets()).toHaveLength(1);
        } else {
          await expect(first.openPanel(input)).rejects.toBeInstanceOf(
            mode === "pre-focus-read-failed" ? AdapterCommandError : AdapterProtocolError,
          );
          expect(effects).toBe(0);
          expect((await openFiles(home)).filter((name) => !name.endsWith(".lock"))).toEqual([]);
          expect(await backend().openPanel(input)).toBe("4");
          const before = effects;
          expect(await first.openPanel(input)).toBe("4");
          expect(effects).toBe(before);
        }
      } else if (mode === "success" || (splitKind !== undefined && mode.endsWith("-success"))) {
        const expected = {
          paneId: "4",
          project: home,
          ...(mode === "brief-success"
            ? {
                endpoint: {
                  ...endpoint,
                  terminal: "tern" as const,
                  terminalSessionId: "1",
                  paneId: "4",
                },
              }
            : {}),
        };
        expect(await open()).toEqual(expected);
        const before = effects;
        expect(await open()).toEqual(expected);
        expect(effects).toBe(before + (mode === "prs-success" ? 1 : 0));
      } else {
        await expect(open()).rejects.toThrow();
        if (
          [
            "unknown",
            "brief-unknown",
            "pr-unknown",
            "wrong-kind",
            "verification-failed",
            "verification-malformed",
            "wrong-placement",
          ].includes(mode)
        ) {
          const before = effects;
          if (["verification-failed", "verification-malformed"].includes(mode)) {
            expect((await open()).paneId).toBe("4");
            expect(await Bun.file(routePath).exists()).toBe(false);
            expect((await openFiles(home)).filter((name) => !name.endsWith(".lock"))).toEqual([]);
          } else {
            await expect(open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
            expect(await Bun.file(routePath).exists()).toBe(true);
            expect(await tickets()).toHaveLength(1);
          }
          expect(effects).toBe(before);
          expect(created).toBe(true);
        } else expect(effects).toBe(0);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

test("PR detail navigation resolves the cached repository and number without requiring a task", () => {
  const shown = {
    summary: {
      terminal: "tern" as const,
      repoPath: "/fixture",
      name: "fixture",
      writtenAt: "2030-01-01T00:00:00.000Z",
      running: 0,
      needsYou: 0,
      ready: 0,
      done: 0,
    },
    changeSignature: "fixture",
    projects: [],
    boardLinks: {},
    merged: [],
    needsYou: [],
    tasks: [],
    pullRequests: [
      { repo: "one/repo", number: 42 },
      { repo: "two/repo", number: 42, taskId: "owned" },
    ],
  };
  expect(detailForView(shown, { kind: "pr", repo: "one/repo", number: 42 })).toBe(
    "pr-one%2Frepo-42.json",
  );
  expect(detailForView(shown, { kind: "pr", repo: "two/repo", number: 42 })).toBe(
    "pr-two%2Frepo-42.json",
  );
  expect(detailForView(shown, { kind: "pr", taskId: "owned" })).toBe("pr-two%2Frepo-42.json");
  expect(detailForView(shown, { kind: "pr", repo: "missing/repo", number: 42 })).toBeUndefined();
});
