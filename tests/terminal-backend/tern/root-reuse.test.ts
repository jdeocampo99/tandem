import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";

async function fixture(kind: "board" | "usage" | "catchup" | "prs", mode = "confirmed") {
  const home = await mkdtemp("/tmp/tandem-root-reuse-");
  const index = nativeViewsPath(home, home);
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
  const placement = kind === "prs" ? "split" : "window";
  const args = [index, "3", home, "own-window", index];
  let roots = 0,
    opens = 0,
    now = 0;
  let detached = false;
  const focused: string[] = [];
  const run: CommandRunner = async (request) => {
    const ok = (value: unknown) => ({ code: 0, stderr: "", stdout: JSON.stringify(value) });
    const verb = request.argv[1];
    if (verb === "ls") {
      const rootBlocks = Array.from({ length: roots }, (_, n) => ({
        id: String(4 + n),
        cwd: home,
        title: "Same title",
        live: false,
        program: `tandem.${kind}`,
        args,
      }));
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
                  { id: "3", cwd: home, title: "Same title", live: true, cols: 150 },
                  ...(placement === "split" && !detached ? rootBlocks : []),
                ],
              },
              ...(placement === "window" && roots > 0 && !detached
                ? [{ id: "6", name: null, blocks: rootBlocks }]
                : []),
            ],
          },
        ],
        detached: detached ? rootBlocks : [],
      });
    }
    if (verb === "process")
      return ok({ pane: request.argv[2], child: null, foreground: null, group: null });
    if (verb === "focus") {
      focused.push(request.argv[2] ?? "");
      return ok({ block: request.argv[2] });
    }
    if (verb === "open") {
      opens++;
      const ticket = JSON.parse(await readFile(request.argv[2] ?? "", "utf8"));
      if (ticket.placement === "return") {
        if (ticket.closeOrigin !== undefined) roots = 0;
        await writeFile(
          ticket.receipt,
          JSON.stringify({ paneId: "3", tabId: "2", sessionId: "1" }),
        );
        return ok({ blocks: ["3"], discarded: false });
      }
      // Keep the first effect in flight while concurrent callers contend for the lock.
      await Bun.sleep(40);
      roots = mode === "missing" ? 0 : mode === "duplicate" ? 2 : roots + 1;
      if (mode !== "confirmed")
        return { code: 1, stdout: "", stderr: "lost opening acknowledgement" };
      await writeFile(
        ticket.receipt,
        JSON.stringify({
          paneId: String(3 + roots),
          tabId: placement === "split" ? "2" : "6",
          sessionId: "1",
        }),
      );
      return ok({ blocks: [String(3 + roots)], discarded: false });
    }
    throw new Error(`unexpected ${verb}`);
  };
  const host = () =>
    ternViewHost(ternCommands(run, { windowKey: "own-window" }), {
      wait: async (ms) => {
        now += ms;
      },
      clock: () => now,
      guard: async (_key, operation) => operation(),
    });
  const input = {
    home,
    cwd: home,
    coordinator,
    origin: { paneId: "3", windowId: "own-window" },
    view: { kind } as const,
  };
  return {
    home,
    index,
    input,
    host,
    focused,
    open: () => host().open(input, home, kind, placement, index),
    return: () =>
      host().open(
        {
          ...input,
          view: { kind: "orchestrator" },
          origin: { paneId: roots === 0 ? "3" : "4", windowId: "own-window" },
        },
        home,
        "panel",
        "return",
        index,
      ),
    evidence: async () =>
      (await readdir(`${home}/native-host`)).filter((name) => !name.endsWith(".lock")),
    opens: () => opens,
    roots: () => roots,
    seed: (count: number, detachedOnly = false, window = "own-window") => {
      roots = count;
      detached = detachedOnly;
      args[3] = window;
    },
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

for (const kind of ["board", "usage", "catchup", "prs"] as const) {
  test(`concurrent ${kind} openings reuse one exact view under the durable lock`, async () => {
    const f = await fixture(kind);
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => f.open()));
      expect(results.map((result) => result.paneId)).toEqual(["4", "4", "4", "4", "4", "4"]);
      expect(f.opens()).toBe(1);
      expect(f.roots()).toBe(1);
      expect(f.focused).toEqual(["3", "4", "4", "4", "4", "4"]);
      expect(await f.evidence()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
}

for (const mode of ["exact", "missing", "duplicate"] as const) {
  test(`Return from an unresolved usage open: ${mode} evidence preserves a safe exit`, async () => {
    const f = await fixture("usage", mode);
    try {
      await expect(f.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      const retained = await f.evidence();
      expect(retained.some((name) => name.endsWith(".intent.json"))).toBe(true);
      const result = await f.return();
      expect(result.paneId).toBe("3");
      if (mode === "exact") {
        expect(result.warnings).toBeUndefined();
        expect(f.opens()).toBe(2); // a proved Return route, never another usage open
        expect(f.roots()).toBe(0);
        expect(await f.evidence()).toEqual([]);
      } else {
        expect(result.warnings?.[0]).toContain("Returned to your conversation");
        expect(result.warnings?.[0]).toContain("tab switcher");
        expect(f.opens()).toBe(1);
        expect(f.focused).toEqual(["3", "3"]);
        expect(f.roots()).toBe(mode === "duplicate" ? 2 : 0);
        expect(await f.evidence()).toEqual(retained);
        await expect(f.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
        expect(f.opens()).toBe(1);
      }
    } finally {
      await f.dispose();
    }
  });
}

test("a fresh usage invocation recovers a lost acknowledgement without opening again", async () => {
  const f = await fixture("usage", "exact");
  try {
    await expect(f.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    expect((await f.open()).paneId).toBe("4");
    expect(f.opens()).toBe(1);
    expect(await f.evidence()).toEqual([]);
  } finally {
    await f.dispose();
  }
});

for (const kind of ["board", "usage"] as const) {
  test(`fresh ${kind} hosts focus the unique existing full-window view without a layout effect`, async () => {
    const f = await fixture(kind);
    try {
      f.seed(1);
      expect((await f.open()).paneId).toBe("4");
      expect((await f.open()).paneId).toBe("4");
      expect(f.opens()).toBe(0);
      expect(f.focused).toEqual(["4", "4"]);
      expect(f.roots()).toBe(1);
      expect(await f.evidence()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  for (const ambiguity of ["duplicate", "detached", "wrong-window"] as const) {
    test(`fresh ${kind} hosts refuse ${ambiguity} full-window evidence before any effect`, async () => {
      const f = await fixture(kind);
      try {
        f.seed(
          ambiguity === "duplicate" ? 2 : 1,
          ambiguity === "detached",
          ambiguity === "wrong-window" ? "foreign-window" : "own-window",
        );
        await expect(f.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
        await expect(f.open()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
        expect(f.opens()).toBe(0);
        expect(f.focused).toEqual([]);
        expect(await f.evidence()).toEqual([]);
      } finally {
        await f.dispose();
      }
    });
  }
}
