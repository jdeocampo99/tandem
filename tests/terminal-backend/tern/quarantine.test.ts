import { expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TernEndpoint, ternEndpoint } from "../../../src/terminal-backend/identity.ts";
import type { TernOp } from "../../../src/terminal-backend/tern/cli.ts";
import {
  TernOutcomeUnknownError,
  TernQuarantinedError,
} from "../../../src/terminal-backend/tern/protocol.ts";
import {
  clearTernQuarantine,
  listTernQuarantine,
  ternQuarantine,
} from "../../../src/terminal-backend/tern/quarantine.ts";
import { withScenario } from "../../evals/scenario.ts";

function operations(endpoint: TernEndpoint, cwd: string): readonly TernOp[] {
  const target = { endpoint, cwd };
  return [
    { ...target, verb: "focus" },
    { ...target, verb: "run", line: { command: ["true"] } },
    { ...target, verb: "send", input: { keys: ["ctrl+c"] } },
    { ...target, verb: "rename", label: "renamed" },
    { ...target, verb: "split" },
    { cwd, verb: "newTab", session: "1", beside: { endpoint } },
    { cwd, verb: "newSession", name: "new" },
    { ...target, verb: "close", owner: ternEndpoint({ ...endpoint, paneId: "99" }) },
    { cwd, verb: "killSession", session: "1", closed: endpoint },
    { ...target, verb: "open", route: "route", receipt: "receipt" },
    { ...target, verb: "browser", url: new URL("https://example.com") },
    { cwd, verb: "notify", helper: endpoint, title: "title", body: "body" },
  ];
}

const recordsAgainstPane = new Set(["run", "send", "rename", "close", "killSession", "notify"]);

test("pane quarantine records each uncertain verb against its exact subject using the injected clock", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    const ledger = ternQuarantine(world.home, () => 1_700_000_000_000);
    for (const op of operations(endpoint, world.repoPath)) {
      await ledger.record(
        op,
        new TernOutcomeUnknownError(`tern ${op.verb}`, new Error("lost ack")),
      );
      const panes = await listTernQuarantine(world.home);
      if (!recordsAgainstPane.has(op.verb) && op.verb !== "split") {
        expect(panes).toEqual([]);
        continue;
      }
      expect(panes).toHaveLength(1);
      const pane = panes[0];
      if (pane?.status !== "readable") throw new Error("expected a readable quarantine");
      expect(JSON.parse(pane.record)).toEqual({
        version: 1,
        key: `${op.verb === "split" ? "split:" : ""}pane:${endpoint.terminalSessionId ?? ""}:42`,
        operation: `tern ${op.verb}`,
        reason: "lost ack",
        at: "2023-11-14T22:13:20.000Z",
        endpoint,
        cwd: world.repoPath,
      });
      expect((await stat(pane.path)).mode & 0o777).toBe(0o600);
      expect(
        (await readdir(join(world.home, "tern-quarantine"))).some((name) => name.endsWith(".tmp")),
      ).toBe(false);
      expect(await clearTernQuarantine(pane, async () => true)).toBe("cleared");
    }
    expect(world.trace().some((event) => event.boundary === "tern")).toBe(false);
  });
});

test("pane quarantine refuses every reference to a quarantined pane and preserves unrelated operations", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    const ledger = ternQuarantine(world.home, () => 0);
    const send: TernOp = { verb: "send", endpoint, cwd: world.repoPath, input: { text: "hello" } };
    await ledger.record(send, new TernOutcomeUnknownError("tern send", "lost ack"));
    for (const op of operations(endpoint, world.repoPath)) {
      if (op.verb === "newSession") await ledger.refuse(op);
      else await expect(ledger.refuse(op)).rejects.toBeInstanceOf(TernQuarantinedError);
    }
    await ledger.refuse({
      verb: "newTab",
      session: "1",
      cwd: world.repoPath,
      beside: { tab: "2" },
    });
    await ledger.refuse({ verb: "newTab", session: "1", cwd: world.repoPath });
    await ledger.refuse({ ...send, endpoint: ternEndpoint({ ...endpoint, paneId: "99" }) });
    await ledger.refuse({
      ...send,
      endpoint: ternEndpoint({ ...endpoint, terminalSessionId: "99" }),
    });
    await expect(
      ledger.refuse({
        verb: "close",
        endpoint: ternEndpoint({ ...endpoint, paneId: "99" }),
        owner: endpoint,
        cwd: world.repoPath,
      }),
    ).rejects.toBeInstanceOf(TernQuarantinedError);
    await ledger.forget(endpoint);
    expect(await listTernQuarantine(world.home)).toEqual([]);
  });
});

test("an uncertain split pauses another split while ordinary pane effects remain available", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    const ledger = ternQuarantine(world.home, () => 0);
    const split: TernOp = { verb: "split", endpoint, cwd: world.repoPath };
    await ledger.record(split, new TernOutcomeUnknownError("tern split", "lost ack"));
    await expect(ledger.refuse(split)).rejects.toBeInstanceOf(TernQuarantinedError);
    await ledger.refuse({ ...split, verb: "focus" });
    await ledger.refuse({ ...split, verb: "send", input: { text: "hello" } });
    await ledger.forget(endpoint);
    expect(await listTernQuarantine(world.home)).toEqual([]);
  });
});

test("pane quarantine keeps the original record when a refusal or known failure is reported", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    const op: TernOp = { verb: "split", endpoint, cwd: world.repoPath };
    const ledger = ternQuarantine(world.home, () => 0);
    await ledger.record(op, new TernOutcomeUnknownError("tern split", "original failure"));
    const original = await listTernQuarantine(world.home);
    await ledger.record(op, new TernQuarantinedError("tern split", "already quarantined"));
    await ledger.record(op, new Error("known failure"));
    expect(await listTernQuarantine(world.home)).toEqual(original);
    const disabled = ternQuarantine(undefined, () => {
      throw new Error("unused clock");
    });
    await disabled.record(op, new TernOutcomeUnknownError("tern split", "no home"));
    await disabled.refuse(op);
    await disabled.forget(endpoint);
  });
});

test("clearing a pane quarantine re-proves only an unchanged record and retains unproven records", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    await ternQuarantine(world.home, () => 0).record(
      { verb: "split", endpoint, cwd: world.repoPath },
      new TernOutcomeUnknownError("tern split", "lost ack"),
    );
    const [pane] = await listTernQuarantine(world.home);
    if (pane?.status !== "readable") throw new Error("expected a readable quarantine");
    expect(await clearTernQuarantine(pane, async () => false)).toBe("unproven");
    expect(await readFile(pane.path, "utf8")).toBe(pane.record);
    await writeFile(pane.path, `${pane.record}\n`);
    expect(
      await clearTernQuarantine(pane, async () => {
        throw new Error("changed record must not be re-proved");
      }),
    ).toBe("changed");
    expect(await readFile(pane.path, "utf8")).toBe(`${pane.record}\n`);
  });
});

test("pane quarantine writers wait for a clear's record lock and preserve the newer failure", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    const op: TernOp = { verb: "split", endpoint, cwd: world.repoPath };
    const ledger = ternQuarantine(world.home, () => 0);
    await ledger.record(op, new TernOutcomeUnknownError("tern split", "original"));
    const [pane] = await listTernQuarantine(world.home);
    if (pane?.status !== "readable") throw new Error("expected a readable quarantine");
    const proving = Promise.withResolvers<void>();
    const releaseProof = Promise.withResolvers<boolean>();
    const clearing = clearTernQuarantine(pane, async () => {
      proving.resolve();
      return releaseProof.promise;
    });
    await proving.promise;
    const writing = ledger.record(op, new TernOutcomeUnknownError("tern split", "newer"));
    try {
      expect(
        await Promise.race([writing.then(() => "wrote"), Bun.sleep(100).then(() => "waiting")]),
      ).toBe("waiting");
      expect(await readFile(pane.path, "utf8")).toBe(pane.record);
    } finally {
      releaseProof.resolve(true);
    }
    expect(await clearing).toBe("cleared");
    await writing;
    expect(await listTernQuarantine(world.home)).toEqual([
      expect.objectContaining({ reason: "newer" }),
    ]);
  });
});

test("a failed quarantine write preserves the original operation and explains the unsaved record", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "42", cwd: world.repoPath }));
    await writeFile(join(world.home, "tern-quarantine"), "not a directory");
    const ledger = ternQuarantine(world.home, () => 0);
    const failure = await ledger
      .record(
        { verb: "split", endpoint, cwd: world.repoPath },
        new TernOutcomeUnknownError("tern split verification", "lost acknowledgement"),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TernOutcomeUnknownError);
    if (!(failure instanceof TernOutcomeUnknownError))
      throw new Error("expected an unknown outcome");
    expect(failure.operation).toBe("tern split verification");
    expect(failure.message).toBe(
      "tern split verification outcome is unknown; quarantine and keep resources",
    );
    expect(failure.cause).toEqual(
      expect.stringContaining("lost acknowledgement; its quarantine could not be recorded: "),
    );
    expect(await readFile(join(world.home, "tern-quarantine"), "utf8")).toBe("not a directory");
  });
});
