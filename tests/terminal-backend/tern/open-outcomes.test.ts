import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { acquireDarwinFileLock } from "../../../src/tasks/store-lock.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import {
  NativeViewNotOpenedError,
  recoverViewOpens,
} from "../../../src/terminal-backend/tern/host.ts";
import { TernOutcomeUnknownError } from "../../../src/terminal-backend/tern/protocol.ts";
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

type HostReply =
  | Readonly<{ status: "done" }>
  | Readonly<{ status: "failed"; appliedEffects: number }>
  | Readonly<{ status: "silent" }>;

/** A Tern whose plugin answers each `tern open` with the next scripted receipt. */
async function withTern(
  replies: HostReply[],
  body: (tern: {
    open: () => Promise<unknown>;
    opens: () => number;
    lateReceipt: (receipt: unknown) => Promise<void>;
    retained: () => Promise<readonly string[]>;
    /** The coordinator's tick: settles whatever is now decided, without a click. */
    tick: () => Promise<void>;
    home: string;
    advance: (ms: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp("/tmp/tandem-open-outcomes-");
  let opens = 0;
  let task: readonly string[] | undefined;
  let lastReceipt = "";
  let now = 0;
  const run: CommandRunner = async (request) => {
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    const verb = request.argv[1];
    if (verb === "inspect") return ok({ clients: [{ kind: "window" }] });
    if (verb === "focus") return ok({ block: "3" });
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
                  ...(task === undefined
                    ? []
                    : [
                        {
                          id: "5",
                          title: "task",
                          cwd: home,
                          live: false,
                          program: "tandem.task",
                          args: task,
                        },
                      ]),
                ],
              },
            ],
          },
        ],
        detached: [],
      });
    if (verb === "open") {
      opens++;
      const ticket = JSON.parse(await readFile(request.argv[2] ?? "", "utf8"));
      lastReceipt = ticket.receipt;
      const reply = replies.shift() ?? { status: "silent" };
      if (reply.status === "done") {
        task = ticket.args;
        await writeFile(
          ticket.receipt,
          JSON.stringify({ status: "done", paneId: "5", tabId: "2", sessionId: "1" }),
        );
      } else if (reply.status === "failed")
        await writeFile(
          ticket.receipt,
          JSON.stringify({
            status: "failed",
            stage: "task",
            appliedEffects: reply.appliedEffects,
            reason: "Native block could not open",
          }),
        );
      return { code: 1, stdout: "", stderr: "cannot open in a file block" };
    }
    throw new Error(`unexpected ${verb}`);
  };
  const open = () =>
    ternViewHost(
      ternCli(run, {
        binary: "tern",
        clock: () => now,
        wait: async (ms) => {
          now += ms;
        },
      }),
    ).open(
      { home, cwd: home, coordinator, view: { kind: "task", taskId: "task-new" } },
      home,
      "task",
      "task",
      `${home}/new-task.json`,
    );
  try {
    await body({
      open,
      opens: () => opens,
      lateReceipt: (receipt) =>
        writeFile(lastReceipt, typeof receipt === "string" ? receipt : JSON.stringify(receipt)),
      retained: async () =>
        (await readdir(`${home}/native-host`)).filter((name) => !name.endsWith(".lock")),
      home,
      tick: () => recoverViewOpens(ternCli(run, { binary: "tern" }), home, now),
      advance: (ms) => {
        now += ms;
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a host failure before any layout effect settles, and the next click opens", async () => {
  await withTern([{ status: "failed", appliedEffects: 0 }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toBeInstanceOf(NativeViewNotOpenedError);
    expect(await tern.retained()).toEqual([]);
    expect(await tern.open()).toMatchObject({ paneId: "5" });
    expect(tern.opens()).toBe(2);
    expect(await tern.retained()).toEqual([]);
  });
});

test("a host failure after a layout effect stays quarantined and is never retried", async () => {
  await withTern([{ status: "failed", appliedEffects: 1 }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    const retained = await tern.retained();
    expect(retained.filter((name) => name.endsWith(".ticket.json"))).toHaveLength(1);
    await expect(tern.open()).rejects.toThrow("tern open recovery outcome is unknown");
    expect(tern.opens()).toBe(1);
    expect(await tern.retained()).toEqual(retained);
  });
});

test("a zero-effect failure receipt that arrives after the wait settles on the next click", async () => {
  await withTern([{ status: "silent" }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    await expect(tern.open()).rejects.toThrow("tern open recovery outcome is unknown");
    expect(tern.opens()).toBe(1);
    await tern.lateReceipt({
      status: "failed",
      stage: "identity",
      appliedEffects: 0,
      reason: "Exact originating panes disappeared",
    });
    expect(await tern.open()).toMatchObject({ paneId: "5" });
    expect(tern.opens()).toBe(2);
    expect(await tern.retained()).toEqual([]);
  });
});

test("a receipt read mid-write never settles or quarantines on its own", async () => {
  await withTern([{ status: "silent" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    await tern.lateReceipt('{"status":"failed","stage":"task","appliedEff');
    await expect(tern.open()).rejects.toThrow("tern open recovery outcome is unknown");
    expect(tern.opens()).toBe(1);
  });
});

test("a late zero-effect receipt settles on the coordinator's tick, before any click", async () => {
  await withTern([{ status: "silent" }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    await tern.lateReceipt({
      status: "failed",
      stage: "identity",
      appliedEffects: 0,
      reason: "Exact originating panes disappeared",
    });
    await tern.tick();
    expect(await tern.retained()).toEqual([]);
    expect(await tern.open()).toMatchObject({ paneId: "5" });
  });
});

test("an open Tern never answers stays paused after its ticket expires", async () => {
  await withTern([{ status: "silent" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    await expect(tern.open()).rejects.toHaveProperty(
      "cause",
      "an earlier Tandem view is still opening",
    );
    tern.advance(60_000);
    await tern.tick();
    await expect(tern.open()).rejects.toHaveProperty(
      "cause",
      "Tern never confirmed the view opened",
    );
    expect(tern.opens()).toBe(1);
  });
});

test("a receipt that arrives after tandem fix abandoned its ticket is removed, not kept", async () => {
  await withTern([{ status: "silent" }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    const [ticket] = (await tern.retained()).filter((name) => name.endsWith(".ticket.json"));
    await rm(`${tern.home}/native-host/${ticket}`);
    await tern.lateReceipt({ status: "done", paneId: "5", tabId: "2", sessionId: "1" });
    await tern.tick();
    expect(await tern.retained()).toEqual([]);
    expect(await tern.open()).toMatchObject({ paneId: "5" });
  });
});

test("the coordinator's tick skips an open in progress instead of waiting for its lock", async () => {
  await withTern([{ status: "silent" }, { status: "done" }], async (tern) => {
    await expect(tern.open()).rejects.toThrow("tern open outcome is unknown");
    await tern.lateReceipt({
      status: "failed",
      stage: "identity",
      appliedEffects: 0,
      reason: "Exact originating panes disappeared",
    });
    const [lock] = (await readdir(`${tern.home}/native-host`)).filter((name) =>
      name.endsWith(".lock"),
    );
    const release = await acquireDarwinFileLock(`${tern.home}/native-host/${lock}`, 1000, 20);
    try {
      const started = performance.now();
      await tern.tick();
      expect(performance.now() - started).toBeLessThan(1000);
      expect((await tern.retained()).filter((name) => name.endsWith(".ticket.json"))).toHaveLength(
        1,
      );
    } finally {
      await release();
    }
    await tern.tick();
    expect(await tern.retained()).toEqual([]);
  });
});
