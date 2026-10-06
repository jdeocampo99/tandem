import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

// Derived from the #282 safety verifier's task-replacement-probe.ts: a new
// acknowledgement is insufficient evidence that the previous task was closed.
for (const placement of ["task", "return"] as const) {
  for (const mode of [
    "retained",
    "detached",
    "failed-listing",
    "malformed-listing",
    "closed",
  ] as const) {
    test(`${placement} replacement ${mode} settles only after exact predecessor absence`, async () => {
      const home = await mkdtemp("/tmp/tandem-retained-task-");
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
      const index = nativeViewsPath(home, home);
      const oldArgs = [`${home}/old-task.json`, "3", home, "", index];
      const args = [placement === "task" ? `${home}/new-task.json` : index, "3", home, "", index];
      let created = false,
        opens = 0,
        focuses = 0,
        failListing = true;
      let route = "",
        receipt = "";
      const run: CommandRunner = async (request) => {
        const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
        const verb = request.argv[1];
        if (verb !== "ls" || request.argv.includes("--window"))
          expect(request.argv).toContain("own-window");
        if (verb === "inspect") return ok({ clients: [{ kind: "window" }] });
        if (verb === "ls") {
          if (
            created &&
            failListing &&
            (mode === "failed-listing" || mode === "malformed-listing")
          ) {
            failListing = false;
            return {
              code: mode === "failed-listing" ? 1 : 0,
              stdout: "malformed",
              stderr: "lost replacement snapshot",
            };
          }
          const old = {
            id: "4",
            title: "old task",
            cwd: home,
            live: false,
            program: "tandem.task",
            args: oldArgs,
          };
          return ok({
            sessions: [
              {
                id: "1",
                name: "fixture",
                tabs: [
                  {
                    id: "2",
                    name: null,
                    blocks: [
                      { id: "3", title: "coordinator", cwd: home, live: true, cols: 150 },
                      ...(!created || (mode !== "closed" && mode !== "detached") ? [old] : []),
                      ...(created && placement === "task"
                        ? [
                            {
                              id: "5",
                              title: "new task",
                              cwd: home,
                              live: false,
                              program: "tandem.task",
                              args,
                            },
                          ]
                        : []),
                    ],
                  },
                ],
              },
            ],
            detached: created && mode === "detached" ? [old] : [],
          });
        }
        if (verb === "focus") {
          focuses++;
          return ok({ block: "3" });
        }
        if (verb === "open") {
          opens++;
          route = request.argv[2] ?? "";
          const ticket = JSON.parse(await readFile(route, "utf8"));
          expect(ticket.replaced).toBe("4");
          expect(ticket.placement).toBe(placement);
          receipt = ticket.receipt;
          created = true;
          await writeFile(
            receipt,
            JSON.stringify({
              status: "done",
              paneId: placement === "task" ? "5" : "3",
              tabId: "2",
              sessionId: "1",
            }),
          );
          return { code: 1, stdout: "", stderr: "cannot open in a file block" };
        }
        throw new Error(`unexpected ${verb}`);
      };
      const fresh = () =>
        ternViewHost(ternCommands(run, { binary: "tern", windowKey: "own-window" }), {
          clock: Date.now,
          wait: async () => {},
          guard: async (_key, operation) => operation(),
        });
      const open = () =>
        fresh().open(
          {
            home,
            cwd: home,
            coordinator,
            view:
              placement === "task"
                ? { kind: "task", taskId: "task-new" }
                : { kind: "orchestrator" },
          },
          home,
          placement === "task" ? "task" : "panel",
          placement,
          args[0] ?? "",
        );
      try {
        if (mode === "closed") {
          expect((await open()).paneId).toBe(placement === "task" ? "5" : "3");
          expect(
            (await readdir(`${home}/native-host`)).filter((name) => !name.endsWith(".lock")),
          ).toEqual([]);
        } else {
          await expect(open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
          const intent = (await readdir(`${home}/native-host`)).find((name) =>
            name.endsWith(".intent.json"),
          );
          expect(intent).toBeDefined();
          const path = `${home}/native-host/${intent}`;
          const saved = JSON.parse(await readFile(path, "utf8"));
          expect(saved.ticket.replaced).toBe("4");
          const before = opens,
            focused = focuses;
          // Recovery must fence the complete outcome, even when the new task's
          // exact program and launch arguments are visible to a fresh CLI instance.
          if (placement === "return") {
            const returned = await open();
            expect(returned.paneId).toBe("3");
            expect(returned.warnings?.[0]).toContain("recovery record were kept");
            expect(focuses).toBe(focused + 1); // safe focus only, no layout retry
          } else {
            await expect(open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
            expect(focuses).toBe(focused);
          }
          expect(opens).toBe(before);
          expect(await Bun.file(route).exists()).toBe(true);
          expect(await Bun.file(receipt).exists()).toBe(true);
          expect(await Bun.file(path).exists()).toBe(true);
        }
        expect(opens).toBe(1);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
}

// A crash inside settle() after the route was removed leaves only the intent. The
// exact block plus an intent with no predecessor is complete evidence of the opening.
test("task opening interrupted during settle reuses its exact block without reopening", async () => {
  const home = await mkdtemp("/tmp/tandem-settle-crash-");
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
  const index = nativeViewsPath(home, home);
  const args = [`${home}/new-task.json`, "3", home, "", index];
  let created = false,
    opens = 0;
  let route = "";
  const run: CommandRunner = async (request) => {
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    const verb = request.argv[1];
    if (verb === "inspect") return ok({ clients: [{ kind: "window" }] });
    if (verb === "ls")
      return ok({
        sessions: [
          {
            id: "1",
            name: "fixture",
            tabs: [
              {
                id: "2",
                name: null,
                blocks: [
                  { id: "3", title: "coordinator", cwd: home, live: true, cols: 150 },
                  ...(created
                    ? [
                        {
                          id: "5",
                          title: "new task",
                          cwd: home,
                          live: false,
                          program: "tandem.task",
                          args,
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
        ],
        detached: [],
      });
    if (verb === "focus") return ok({ block: "3" });
    if (verb === "open") {
      opens++;
      route = request.argv[2] ?? "";
      created = true;
      return { code: 1, stdout: "", stderr: "connection lost after open" };
    }
    throw new Error(`unexpected ${verb}`);
  };
  const open = () =>
    ternViewHost(ternCommands(run, { binary: "tern", windowKey: "own-window" }), {
      clock: Date.now,
      wait: async () => {},
      guard: async (_key, operation) => operation(),
    }).open(
      { home, cwd: home, coordinator, view: { kind: "task", taskId: "task-new" } },
      home,
      "task",
      "task",
      args[0] ?? "",
    );
  try {
    await expect(open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    const intent = (await readdir(`${home}/native-host`)).find((name) =>
      name.endsWith(".intent.json"),
    );
    expect(intent).toBeDefined();
    const saved = JSON.parse(await readFile(`${home}/native-host/${intent}`, "utf8"));
    expect(saved.ticket.replaced).toBeUndefined();
    await rm(route);

    expect((await open()).paneId).toBe("5");
    expect(opens).toBe(1);
    expect(
      (await readdir(`${home}/native-host`)).filter((name) => !name.endsWith(".lock")),
    ).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
