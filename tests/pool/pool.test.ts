import { expect, test } from "bun:test";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/contracts.ts";
import { maintainPool } from "../../src/pool/maintenance.ts";

type WorktreeState = Readonly<{
  statusOutput?: string;
  unmergedOutput?: string;
  merged?: boolean;
}>;

type PoolRunner = Readonly<{
  calls: CommandRequest[];
  destroyed: string[];
  run: CommandRunner;
}>;

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function statusRecord(
  path: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name: path.split("/").at(-1) ?? "copy",
    path,
    status: "available",
    flavor: "git",
    lease_id: "",
    lease_holder: "",
    leased_at: null,
    processes: [],
    ...overrides,
  };
}

function poolRunner(
  records: readonly Record<string, unknown>[],
  states: Readonly<Record<string, WorktreeState>> = {},
): PoolRunner {
  const calls: CommandRequest[] = [];
  const destroyed: string[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const [tool, second, , fourth, fifth] = request.argv;
    if (tool === "treehouse" && second === "--root" && fourth === "status") {
      return result(JSON.stringify(records));
    }
    if (tool === "treehouse" && second === "--root" && fourth === "destroy") {
      if (fifth === undefined || request.argv[5] !== "--yes")
        throw new Error("destroy target was not exact");
      destroyed.push(fifth);
      return result();
    }
    if (tool !== "git") throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    const path = request.cwd;
    const state = states[path] ?? {};
    if (request.argv.includes("status")) return result(state.statusOutput ?? "");
    if (request.argv.includes("--diff-filter=U")) return result(state.unmergedOutput ?? "");
    if (request.argv.includes("--show-toplevel")) return result(path === "/repo" ? "/repo" : path);
    if (request.argv.includes("HEAD"))
      return result(path === "/repo" ? "primary-head" : "copy-head");
    if (request.argv.includes("merge-base")) return result("", state.merged === false ? 1 : 0);
    throw new Error(`unexpected git command ${JSON.stringify(request.argv)}`);
  };
  return { calls, destroyed, run };
}

function availableSequence(values: readonly number[]): Readonly<{
  readonly paths: string[];
  readonly read: (path: string) => Promise<number>;
}> {
  const fallback = values.at(-1);
  if (fallback === undefined) throw new Error("available sequence must not be empty");
  const paths: string[] = [];
  let index = 0;
  return {
    paths,
    read: async (path) => {
      paths.push(path);
      const value = values[index] ?? fallback;
      index += 1;
      return value;
    },
  };
}

function identityRealpath(path: string): Promise<string> {
  return Promise.resolve(path);
}

const baseInput = {
  repo: "/repo",
  root: "/pool",
  protectedPaths: [],
  minimumFreeBytes: 5,
};

test("preserves live, foreign, dirty, unmerged, ignored, and protected copies", async () => {
  const records = [
    statusRecord("/pool/good"),
    statusRecord("/pool/live", { processes: [{ pid: 41 }] }),
    statusRecord("/pool/foreign"),
    statusRecord("/pool/dirty"),
    statusRecord("/pool/unmerged"),
    statusRecord("/pool/ignored"),
    statusRecord("/pool/protected"),
  ];
  const runner = poolRunner(records, {
    "/pool/dirty": { statusOutput: "?? unique.txt\n" },
    "/pool/unmerged": { unmergedOutput: "conflict.txt\n" },
    "/pool/ignored": { statusOutput: "!! generated.env\n" },
  });
  const available = availableSequence([20]);

  const maintenance = await maintainPool(
    runner.run,
    {
      ...baseInput,
      managedPaths: [
        "/pool/good",
        "/pool/live",
        "/pool/dirty",
        "/pool/unmerged",
        "/pool/ignored",
        "/pool/protected",
      ],
      protectedPaths: ["/pool/protected"],
      retainIdle: 0,
    },
    { realpath: identityRealpath, availableBytes: available.read },
  );

  expect(runner.destroyed).toEqual(["/pool/good"]);
  expect(maintenance.removedPaths).toEqual(["/pool/good"]);
  expect(maintenance.retainedPaths).toEqual([
    "/pool/dirty",
    "/pool/foreign",
    "/pool/ignored",
    "/pool/live",
    "/pool/protected",
    "/pool/unmerged",
  ]);
  expect(maintenance.canAllocate).toBe(true);
  expect(maintenance.warnings.join("\n")).toContain("ignored files");
  expect(maintenance.warnings.join("\n")).toContain("unmerged paths");
});

test("refuses symlink escapes and duplicate or ambiguous metadata", async () => {
  const records = [
    statusRecord("/pool/escape"),
    statusRecord("/pool/duplicate"),
    statusRecord("/pool/duplicate", { name: "duplicate-alias" }),
  ];
  const runner = poolRunner(records);
  const maintenance = await maintainPool(
    runner.run,
    {
      ...baseInput,
      managedPaths: ["/pool/escape", "/pool/duplicate"],
      retainIdle: 0,
    },
    {
      realpath: async (path) => (path === "/pool/escape" ? "/outside/escape" : path),
      availableBytes: async () => 20,
    },
  );

  expect(runner.destroyed).toEqual([]);
  expect(maintenance.removedPaths).toEqual([]);
  expect(maintenance.retainedPaths).toEqual(["/pool/duplicate", "/pool/escape"]);
  expect(maintenance.warnings.join("\n")).toContain("escapes managed root");
  expect(maintenance.warnings.join("\n")).toContain("duplicate path metadata");
});

test("trims ordinary idle extras while retaining the warm target", async () => {
  const runner = poolRunner([
    statusRecord("/pool/a"),
    statusRecord("/pool/b"),
    statusRecord("/pool/c"),
  ]);
  const available = availableSequence([20]);
  const maintenance = await maintainPool(
    runner.run,
    { ...baseInput, managedPaths: ["/pool/a", "/pool/b", "/pool/c"], retainIdle: 1 },
    { realpath: identityRealpath, availableBytes: available.read },
  );

  expect(runner.destroyed).toEqual(["/pool/b", "/pool/c"]);
  expect(maintenance.removedPaths).toEqual(["/pool/b", "/pool/c"]);
  expect(maintenance.retainedPaths).toEqual(["/pool/a"]);
  expect(maintenance.availableBytes).toBe(20);
  expect(maintenance.canAllocate).toBe(true);
});

test("reclaims warm idle copies only while disk pressure remains", async () => {
  const runner = poolRunner([statusRecord("/pool/a"), statusRecord("/pool/b")]);
  const available = availableSequence([2, 3, 6]);
  const maintenance = await maintainPool(
    runner.run,
    { ...baseInput, managedPaths: ["/pool/a", "/pool/b"], retainIdle: 1 },
    { realpath: identityRealpath, availableBytes: available.read },
  );

  expect(runner.destroyed).toEqual(["/pool/b", "/pool/a"]);
  expect(maintenance.removedPaths).toEqual(["/pool/a", "/pool/b"]);
  expect(maintenance.retainedPaths).toEqual([]);
  expect(maintenance.availableBytes).toBe(6);
  expect(maintenance.canAllocate).toBe(true);
});

test("returns an actionable blocker when safe pressure reclamation is insufficient", async () => {
  const runner = poolRunner([statusRecord("/pool/a")]);
  const available = availableSequence([2, 2]);
  const maintenance = await maintainPool(
    runner.run,
    { ...baseInput, managedPaths: ["/pool/a"], retainIdle: 0 },
    { realpath: identityRealpath, availableBytes: available.read },
  );

  expect(runner.destroyed).toEqual(["/pool/a"]);
  expect(maintenance.availableBytes).toBe(2);
  expect(maintenance.canAllocate).toBe(false);
  expect(maintenance.allocationBlocker).toContain("2 bytes available");
  expect(maintenance.allocationBlocker).toContain("5 bytes required");
});

test("measures the destination filesystem from a nearest existing ancestor", async () => {
  const runner = poolRunner([]);
  const queried: string[] = [];
  const missingRootRealpath = async (path: string): Promise<string> => {
    if (path === "/pool/new") {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    }
    return path;
  };
  const availableBytes = async (path: string): Promise<number> => {
    queried.push(path);
    if (path === "/pool/new") {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    }
    return 20;
  };

  const maintenance = await maintainPool(
    runner.run,
    { ...baseInput, root: "/pool/new", managedPaths: [], retainIdle: 0 },
    { realpath: missingRootRealpath, availableBytes },
  );

  expect(queried).toEqual(["/pool/new", "/pool"]);
  expect(maintenance.availableBytes).toBe(20);
  expect(maintenance.canAllocate).toBe(true);
  expect(maintenance.removedPaths).toEqual([]);
});

test("blocks allocation when destination capacity is unknown", async () => {
  const runner = poolRunner([]);
  const maintenance = await maintainPool(
    runner.run,
    { ...baseInput, managedPaths: [], retainIdle: 0 },
    { realpath: identityRealpath, availableBytes: async () => null },
  );

  expect(maintenance.availableBytes).toBeNull();
  expect(maintenance.canAllocate).toBe(false);
  expect(maintenance.allocationBlocker).toContain("free space is unknown");
});
