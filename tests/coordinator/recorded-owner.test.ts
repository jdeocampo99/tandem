import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorRecord } from "../../src/coordinator/record.ts";
import { type CoordinatorClaim, findRecordedOwner } from "../../src/coordinator/recorded-owner.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";

type World = Readonly<{
  home: string;
  repoA: string;
  repoB: string;
  worktreeA: string;
  worktreeB: string;
}>;

let root: string;
let world: World;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tandem-recorded-owner-")));
  world = {
    home: join(root, "home"),
    repoA: join(root, "repo-a"),
    repoB: join(root, "repo-b"),
    worktreeA: join(root, "pool", "a"),
    worktreeB: join(root, "pool", "b"),
  };
  for (const path of [world.repoA, world.repoB, world.worktreeA, world.worktreeB])
    await mkdir(path, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const PANE = {
  terminal: "tern",
  sessionId: "tandem",
  terminalSessionId: "7",
  workspaceId: "3",
  tabId: "3",
  paneId: "11",
  generation: 0,
} as const;

function record(repoPath: string, worktreePath: string, paneId: string): CoordinatorRecord {
  return {
    schemaVersion: 1,
    repoPath,
    endpoint: { ...PANE, paneId, role: "coordinator" },
    worktree: {
      root: join(root, "pool"),
      path: worktreePath,
      name: "coordinator",
      baseHead: "abc123",
      branch: "tandem/coordinator",
      leaseId: `lease-${paneId}`,
      leaseHolder: "coordinator:a",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    harness: DEFAULT_HARNESS,
    command: ["omp"],
  };
}

/** `distinct`: A and B in their own panes and worktrees. `duplicate`: B claims A's pane and worktree. */
type Registry = "distinct" | "duplicate";

type PaneOverrides = Partial<{
  [K in keyof typeof PANE]: K extends "terminal"
    ? "tern" | "herdr"
    : K extends "generation"
      ? number
      : string;
}>;

const paneClaim =
  (pane: PaneOverrides = {}, cwd?: string): ((world: World) => CoordinatorClaim) =>
  (current) => ({ by: "pane", pane: { ...PANE, ...pane }, cwd: cwd ?? current.worktreeA });

const projectClaim =
  (
    path: (world: World) => string,
    extra: Partial<{ terminal: "tern" | "herdr" | "any"; paneId: string; sessionId: string }> = {},
  ): ((world: World) => CoordinatorClaim) =>
  (current) => ({
    by: "project",
    sessionId: extra.sessionId ?? "tandem",
    path: path(current),
    terminal: extra.terminal ?? "tern",
    ...(extra.paneId === undefined ? {} : { paneId: extra.paneId }),
  });

const cases: readonly (readonly [
  name: string,
  registry: Registry,
  claim: (world: World) => CoordinatorClaim,
  expected: "A" | "none" | "ambiguous",
])[] = [
  ["pane: exact recorded endpoint", "distinct", paneClaim(), "A"],
  ["pane: other pane", "distinct", paneClaim({ paneId: "99" }), "none"],
  ["pane: wrong Tandem session", "distinct", paneClaim({ sessionId: "other" }), "none"],
  ["pane: wrong native session", "distinct", paneClaim({ terminalSessionId: "8" }), "none"],
  ["pane: wrong tab", "distinct", paneClaim({ tabId: "4" }), "none"],
  ["pane: wrong workspace", "distinct", paneClaim({ workspaceId: "4" }), "none"],
  ["pane: wrong terminal", "distinct", paneClaim({ terminal: "herdr" }), "none"],
  ["pane: wrong cwd", "distinct", (w) => paneClaim({}, w.worktreeB)(w), "none"],
  ["pane: wrong generation", "distinct", paneClaim({ generation: 1 }), "none"],
  ["pane: two records claim it", "duplicate", paneClaim(), "ambiguous"],
  ["project: repository path", "distinct", projectClaim((w) => w.repoA), "A"],
  ["project: worktree path", "distinct", projectClaim((w) => w.worktreeA), "A"],
  ["project: unrecorded path", "distinct", projectClaim(() => "/nowhere"), "none"],
  [
    "project: wrong session",
    "distinct",
    projectClaim((w) => w.repoA, { sessionId: "other" }),
    "none",
  ],
  [
    "project: wrong terminal",
    "distinct",
    projectClaim((w) => w.repoA, { terminal: "herdr" }),
    "none",
  ],
  ["project: any terminal", "distinct", projectClaim((w) => w.repoA, { terminal: "any" }), "A"],
  ["project: exact pane", "distinct", projectClaim((w) => w.repoA, { paneId: "11" }), "A"],
  ["project: other pane", "distinct", projectClaim((w) => w.repoA, { paneId: "12" }), "none"],
  ["project: two records claim it", "duplicate", projectClaim((w) => w.worktreeA), "ambiguous"],
];

for (const [name, registry, claim, expected] of cases) {
  test(`recorded owner: ${name}`, async () => {
    const home = join(world.home, registry);
    const a = record(world.repoA, world.worktreeA, "11");
    const b =
      registry === "duplicate"
        ? record(world.repoB, world.worktreeA, "11")
        : record(world.repoB, world.worktreeB, "12");
    await saveCoordinatorRecord(home, a);
    await saveCoordinatorRecord(home, b);
    const owner = await findRecordedOwner(home, claim(world));
    if (expected === "A") {
      expect(owner.status).toBe("owned");
      expect(owner.status === "owned" && owner.record.repoPath).toBe(world.repoA);
    } else expect(owner).toEqual({ status: expected });
  });
}
