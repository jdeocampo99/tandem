import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/contracts.ts";
import type { Fence, ReadableFence } from "../../../src/terminal-backend/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { TernOutcomeUnknownError } from "../../../src/terminal-backend/tern/protocol.ts";
import { type ScenarioWorld, withScenario } from "../../evals/scenario.ts";

/** A Tern whose first `send` acknowledges another block, so its outcome is unknown. */
function lostAcknowledgement(world: ScenarioWorld): CommandRunner {
  let sends = 0;
  return async (request) => {
    const result = await world.run(request);
    if (request.argv[1] === "send" && sends++ === 0) return { ...result, stdout: '{"block":"99"}' };
    return result;
  };
}

function readable(fences: readonly Fence[]): ReadableFence {
  const [fence] = fences;
  if (fence?.status !== "readable") throw new Error("expected one readable fence");
  return fence;
}

/** A real Tern pane quarantine record in the scenario's home, and the backend that wrote it. */
async function withQuarantinedPane(
  body: (world: ScenarioWorld, tern: ReturnType<typeof ternBackend>) => Promise<void>,
): Promise<void> {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "42", cwd: world.repoPath });
    const tern = ternBackend(lostAcknowledgement(world), { home: world.home });
    await expect(
      tern.sendKeys({ endpoint, cwd: world.repoPath, keys: ["ctrl+c"] }),
    ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    await body(world, tern);
  });
}

test("Tern lists a quarantined pane as one fence holding its record exactly as written", async () => {
  await withQuarantinedPane(async (world, tern) => {
    const listing = await tern.fences.list(world.home);
    expect(listing.failures).toEqual([]);
    const fence = readable(listing.fences);
    expect(fence).toMatchObject({
      kind: "tern-quarantine",
      protects: { endpoint: { paneId: "42", sessionId: world.sessionId }, cwd: world.repoPath },
      description: expect.stringMatching(
        /^tern send on pane:\d*:42 at \S+ has an unknown outcome/u,
      ),
      proof: {
        settleable: true,
        why: "the pane is idle at its exact id, so the record can be removed; the pane is kept",
      },
    });
    expect(fence.token).toBe(await readFile(fence.path, "utf8"));
  });
});

test("Tern keeps a fence whose record changed since it was listed", async () => {
  await withQuarantinedPane(async (world, tern) => {
    const fence = readable((await tern.fences.list(world.home)).fences);
    await writeFile(fence.path, `${fence.token}\n`);
    expect(await tern.fences.settle(fence)).toEqual({
      status: "kept",
      reason: "the pane quarantine record changed while fix ran, so it was kept",
    });
    expect(await readFile(fence.path, "utf8")).toBe(`${fence.token}\n`);
  });
});

test("Tern re-proves the pane before settling and keeps the fence while it is busy", async () => {
  await withQuarantinedPane(async (world, tern) => {
    const fence = readable((await tern.fences.list(world.home)).fences);
    world.replaceForeground(fence.protects.endpoint.paneId, ["omp", "--mode", "worker"]);
    expect(await tern.fences.settle(fence)).toEqual({
      status: "kept",
      reason: "kept because the pane is not proven gone or idle: the pane is running something",
    });
    expect(await readFile(fence.path, "utf8")).toBe(fence.token);
  });
});

test("Tern removes a settled fence, and one already gone counts as removed", async () => {
  await withQuarantinedPane(async (world, tern) => {
    const fence = readable((await tern.fences.list(world.home)).fences);
    world.removePane(fence.protects.endpoint.paneId);
    expect(await tern.fences.settle(fence)).toEqual({ status: "removed" });
    expect((await tern.fences.list(world.home)).fences).toEqual([]);
    await rm(fence.path, { force: true });
    expect(await tern.fences.settle(fence)).toEqual({ status: "removed" });
  });
});

test("Tern reports a ledger it cannot list and still lists the other", async () => {
  await withQuarantinedPane(async (world, tern) => {
    await rm(join(world.home, "tern"), { recursive: true, force: true });
    await writeFile(join(world.home, "tern"), "not a directory");
    const listing = await tern.fences.list(world.home);
    expect(listing.failures).toEqual([
      {
        kind: "native-open",
        subject: "native view opens",
        reason: expect.stringContaining("paused views could not be listed: "),
      },
    ]);
    expect(listing.fences.map((fence) => fence.kind)).toEqual(["tern-quarantine"]);
  });
});
