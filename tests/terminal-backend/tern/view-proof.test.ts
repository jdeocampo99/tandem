import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { nativeBriefFile } from "../../../src/board/native-views.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { blockArgs } from "../../../src/native/block.ts";
import { viewDetailPath, viewIndexPath } from "../../../src/native/store.ts";
import { setupFile } from "../../../src/native/view-file.ts";
import type { ProvableView } from "../../../src/terminal-backend/contract.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

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

type Listed = Readonly<{ id: string; program?: string; args?: readonly string[] }>;

/** Tern listing one session: the coordinator's tab, plus a worker's tab and any other tabs. */
function runner(home: string, tabs: Readonly<Record<string, readonly Listed[]>>): CommandRunner {
  return async (request) => {
    const verb = request.argv[1];
    let value: unknown;
    if (verb === "inspect") value = { clients: [{ kind: "window" }] };
    else if (verb === "ls")
      value = {
        sessions: [
          {
            id: "1",
            name: "fixture",
            tabs: Object.entries(tabs).map(([id, blocks]) => ({
              id,
              name: null,
              blocks: blocks.map((block) => ({
                title: "Tandem",
                cwd: home,
                live: block.program === undefined,
                ...block,
              })),
            })),
          },
        ],
        detached: [],
      };
    else throw new Error(`A proof only reads; it ran ${verb}`);
    return { code: 0, stderr: "", stdout: JSON.stringify(value) };
  };
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp("/tmp/native-view-proof-");
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function argsFor(home: string, file: string, ctx: Partial<{ coordinator: string }> = {}) {
  return blockArgs(viewDetailPath(home, home, file), {
    coordinator: "3",
    cwd: home,
    home,
    index: viewIndexPath(home, home),
    ...ctx,
  });
}

function prove(
  home: string,
  tabs: Readonly<Record<string, readonly Listed[]>>,
  origin: string,
  view: ProvableView = { kind: "brief", requestId: "req-1" },
) {
  return ternViewHost(ternCli(runner(home, tabs))).proveView(
    { coordinator, cwd: home, home, origin: { paneId: origin }, view },
    home,
  );
}

test("Tern proves only the exact block Tandem launched for this coordinator and subject", async () => {
  await withHome(async (home) => {
    const brief = argsFor(home, nativeBriefFile("req-1"));
    const conversation = { id: "3" };
    const genuine = { id: "4", program: "tandem.brief", args: brief };
    const worker = { id: "6" };
    expect(await prove(home, { "2": [conversation, genuine], "5": [worker] }, "4")).toBe(true);
    // The conversation, a worker's shell and an unlisted pane are never the block.
    expect(await prove(home, { "2": [conversation, genuine], "5": [worker] }, "3")).toBe(false);
    await expect(prove(home, { "2": [conversation, genuine], "5": [worker] }, "6")).resolves.toBe(
      false,
    );
    await expect(prove(home, { "2": [conversation, genuine] }, "9")).rejects.toThrow(
      "origin pane is outside the recorded project session",
    );
    // Another subject, program, file or coordinator is not this view.
    expect(
      await prove(home, { "2": [conversation, genuine] }, "4", {
        kind: "brief",
        requestId: "req-2",
      }),
    ).toBe(false);
    for (const forged of [
      { ...genuine, program: "unrelated.brief" },
      { ...genuine, program: "tandem.task" },
      { ...genuine, args: argsFor(home, nativeBriefFile("req-2")) },
      { ...genuine, args: argsFor(home, nativeBriefFile("req-1"), { coordinator: "8" }) },
      { ...genuine, args: [brief[0], brief[1]] },
    ])
      expect(await prove(home, { "2": [conversation, forged] }, "4")).toBe(false);
  });
});

test("a matching block outside its placement or listed twice is ambiguous, never proved", async () => {
  await withHome(async (home) => {
    const brief = argsFor(home, nativeBriefFile("req-1"));
    const conversation = { id: "3" };
    // A worker that opened a look-alike block in its own tab.
    await expect(
      prove(
        home,
        { "2": [conversation], "5": [{ id: "6", program: "tandem.brief", args: brief }] },
        "6",
      ),
    ).rejects.toThrow("Tern lists this view ambiguously");
    await expect(
      prove(
        home,
        {
          "2": [
            conversation,
            { id: "4", program: "tandem.brief", args: brief },
            { id: "7", program: "tandem.brief", args: brief },
          ],
        },
        "4",
      ),
    ).rejects.toThrow("Tern lists this view ambiguously");
  });
});

test("settings are proved in their own tab and setup beside the conversation", async () => {
  await withHome(async (home) => {
    const conversation = { id: "3" };
    const settings = {
      id: "6",
      program: "tandem.setup",
      args: argsFor(home, setupFile("settings")),
    };
    const setup = { id: "4", program: "tandem.setup", args: argsFor(home, setupFile("setup")) };
    expect(
      await prove(home, { "2": [conversation], "5": [settings] }, "6", {
        kind: "setup",
        mode: "settings",
      }),
    ).toBe(true);
    expect(
      await prove(home, { "2": [conversation, setup] }, "4", { kind: "setup", mode: "setup" }),
    ).toBe(true);
    expect(
      await prove(home, { "2": [conversation, setup] }, "4", { kind: "setup", mode: "settings" }),
    ).toBe(false);
  });
});

test("a task block is proved only for a task the project's views published", async () => {
  await withHome(async (home) => {
    // Nothing is published, so no task block can be this coordinator's.
    expect(
      await prove(home, { "2": [{ id: "3" }, { id: "4", program: "tandem.task" }] }, "4", {
        kind: "task",
        taskId: "task-1",
      }),
    ).toBe(false);
  });
});
