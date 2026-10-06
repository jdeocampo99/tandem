import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TandemEnvironmentSource } from "../../src/config/environment.ts";
import { defaultPolicy } from "../../src/config/policy.ts";
import {
  type CoordinatorSessionReconciliation,
  decideRepositoryCoordinatorClaim,
  PARALLEL_COORDINATORS_VARIABLE,
} from "../../src/coordinator/exclusivity.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  type CoordinatorLaunchResult,
  launchCoordinator,
} from "../../src/coordinator/launch.ts";
import {
  coordinatorRepositoryLockPath,
  withCoordinatorRepositoryLock,
} from "../../src/coordinator/lock.ts";
import { listCoordinatorQuarantineRecords } from "../../src/coordinator/quarantine.ts";
import { digest, recordPath, registrySessionDirectory } from "../../src/coordinator/record.ts";
import {
  type DiscoveredCoordinatorRecord,
  discoverCoordinatorRecords,
  readCoordinatorRecord,
} from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { FIRST_HEAD, fakePool, type Pool, TASK_LEASE_ID } from "./fake-pool.ts";

const FIRST_SESSION = "tandem";
const SECOND_SESSION = "tandem-fresh";

type Fixture = Readonly<{
  readonly root: string;
  readonly repo: string;
  readonly repoLink: string;
  readonly home: string;
  readonly poolRoot: string;
  readonly taskWorktree: string;
  readonly pool: Pool;
  readonly request: (sessionId: string, repo?: string) => CoordinatorLaunchRequest;
  readonly dependencies: (
    processEnvironment?: TandemEnvironmentSource,
  ) => CoordinatorLaunchDependencies;
}>;

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-exclusivity-")));
  const repo = join(root, "repo");
  const repoLink = join(root, "repo-link");
  const home = join(root, "home");
  const poolRoot = join(root, "pool");
  const taskWorktree = join(poolRoot, "task-worktree");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(taskWorktree, { recursive: true });
  await symlink(repo, repoLink);
  const pool = fakePool({ repo, poolRoot, taskWorktreePath: taskWorktree });
  const model = defaultPolicy().models.coordinator;
  let quarantineIds = 0;
  return {
    root,
    repo,
    repoLink,
    home,
    poolRoot,
    taskWorktree,
    pool,
    request: (sessionId, requestedRepo = repo) => ({
      cwd: requestedRepo,
      repo: requestedRepo,
      home,
      poolRoot,
      sessionId,
      harness: DEFAULT_HARNESS,
      model,
      continueSession: false,
      headless: true,
      noAttach: true,
      sourceHead: FIRST_HEAD,
    }),
    dependencies: (processEnvironment = {}) => ({
      run: pool.run,
      terminal: terminalBackend(pool.run, { terminal: "herdr" }),
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("headless launches never attach interactively");
      },
      sleep: async () => undefined,
      processEnvironment,
      clock: () => "2030-01-02T03:04:05.000Z",
      newId: () => {
        quarantineIds += 1;
        return `quarantine-${quarantineIds}`;
      },
    }),
  };
}

function pause(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function foundRecord(
  values: Readonly<{
    readonly sessionId: string;
    readonly placement?: DiscoveredCoordinatorRecord["placement"];
  }>,
): DiscoveredCoordinatorRecord {
  return {
    path: `/home/coordinator-registry/${values.sessionId}/record.json`,
    sessionId: values.sessionId,
    placement: values.placement ?? "session-directory",
    record: {
      schemaVersion: 1,
      repoPath: "/repo",
      endpoint: {
        terminal: "herdr" as const,
        sessionId: values.sessionId,
        workspaceId: "workspace-a",
        tabId: "tab-a",
        paneId: "pane-a",
        role: "coordinator",
        generation: 0,
      },
      worktree: {
        root: "/pool",
        path: "/pool/coordinator-a",
        name: "coordinator-a",
        baseHead: FIRST_HEAD,
        branch: "tandem/coordinator-a",
        leaseId: "lease-a",
        leaseHolder: "coordinator:holder",
        leasedAt: "2030-01-02T03:04:05.000Z",
      },
      harness: DEFAULT_HARNESS,
      command: ["omp"],
    },
  };
}

async function writeStoredRecord(
  home: string,
  directorySessionId: string,
  record: Readonly<Record<string, unknown>>,
  repoPath: string,
): Promise<string> {
  const directory = registrySessionDirectory(home, directorySessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest(repoPath)}.json`);
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function ghostRecord(repoPath: string, poolRoot: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    repoPath,
    endpoint: {
      terminal: "herdr" as const,
      sessionId: "tandem-ghost",
      workspaceId: "workspace-ghost",
      tabId: "tab-ghost",
      paneId: "pane-ghost",
      role: "coordinator",
      generation: 0,
    },
    worktree: {
      root: poolRoot,
      path: join(poolRoot, "coordinator-ghost"),
      name: "coordinator-ghost",
      baseHead: FIRST_HEAD,
      branch: "tandem/coordinator-ghost",
      leaseId: "lease-ghost",
      leaseHolder: "coordinator:ghost",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    command: ["omp", "--model", "ghost"],
  };
}

function reconciliationsOf(
  launch: CoordinatorLaunchResult,
): readonly CoordinatorSessionReconciliation[] {
  return launch.otherSessionReconciliations ?? [];
}

test("the repository claim reconnects, reconciles, or refuses without duplicating a coordinator", () => {
  expect(
    decideRepositoryCoordinatorClaim({
      repoPath: "/repo",
      sessionId: SECOND_SESSION,
      misplaced: [],
      unreadable: [],
      otherSessions: [],
    }).kind,
  ).toBe("allocate");

  const live = decideRepositoryCoordinatorClaim({
    repoPath: "/repo",
    sessionId: SECOND_SESSION,
    misplaced: [],
    unreadable: [],
    otherSessions: [
      { found: foundRecord({ sessionId: FIRST_SESSION }), liveness: { status: "live" } },
    ],
  });
  expect(live.kind).toBe("refuse");
  expect(live.reason).toContain(FIRST_SESSION);
  expect(live.reason).toContain(PARALLEL_COORDINATORS_VARIABLE);
  expect(live.kind === "refuse" ? live.quarantine : ["unexpected"]).toHaveLength(0);

  const stale = decideRepositoryCoordinatorClaim({
    repoPath: "/repo",
    sessionId: SECOND_SESSION,
    misplaced: [],
    unreadable: [],
    otherSessions: [
      { found: foundRecord({ sessionId: FIRST_SESSION }), liveness: { status: "stopped" } },
    ],
  });
  expect(stale.kind).toBe("reconcile");
  expect(stale.kind === "reconcile" ? stale.stale : []).toHaveLength(1);

  const ambiguous = decideRepositoryCoordinatorClaim({
    repoPath: "/repo",
    sessionId: SECOND_SESSION,
    misplaced: [],
    unreadable: [],
    otherSessions: [
      {
        found: foundRecord({ sessionId: FIRST_SESSION }),
        liveness: { status: "ambiguous", detail: "pane cwd moved" },
      },
    ],
  });
  expect(ambiguous.kind).toBe("refuse");
  expect(ambiguous.reason).toContain("pane cwd moved");
  expect(ambiguous.kind === "refuse" ? ambiguous.quarantine : []).toHaveLength(1);

  const misplaced = decideRepositoryCoordinatorClaim({
    repoPath: "/repo",
    sessionId: SECOND_SESSION,
    misplaced: [foundRecord({ sessionId: "tandem-ghost", placement: "foreign-directory" })],
    unreadable: [],
    otherSessions: [],
  });
  expect(misplaced.kind).toBe("refuse");
  expect(misplaced.reason).toContain("does not belong to");
  expect(misplaced.kind === "refuse" ? misplaced.quarantine : []).toHaveLength(1);

  const unreadable = decideRepositoryCoordinatorClaim({
    repoPath: "/repo",
    sessionId: SECOND_SESSION,
    misplaced: [],
    unreadable: [{ path: "/home/coordinator-registry/abc/def.json", reason: "not valid JSON" }],
    otherSessions: [],
  });
  expect(unreadable.kind).toBe("refuse");
  expect(unreadable.reason).toContain("could not be read");
  expect(unreadable.reason).toContain(PARALLEL_COORDINATORS_VARIABLE);
});

test("two spellings of one repository share the repository lock path", async () => {
  const test = await fixture();
  try {
    expect(await coordinatorRepositoryLockPath(test.home, test.repoLink)).toBe(
      await coordinatorRepositoryLockPath(test.home, test.repo),
    );
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a launch waits for the repository lock another session holds under a different spelling", async () => {
  const test = await fixture();
  try {
    let pending: Promise<CoordinatorLaunchResult> | undefined;
    await withCoordinatorRepositoryLock(test.home, test.repoLink, async () => {
      pending = launchCoordinator(test.request(SECOND_SESSION), test.dependencies());
      await pause(60);
      expect(test.pool.panes.size).toBe(0);
      expect(test.pool.coordinatorLeases()).toHaveLength(0);
    });
    if (pending === undefined) throw new Error("the waiting launch never started");
    const launch = await pending;
    expect(launch.paneId).toBeDefined();
    expect(test.pool.panes.size).toBe(1);
    expect(test.pool.coordinatorLeases()).toHaveLength(1);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a stopped coordinator from another session is reconciled before the next session launches", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request(FIRST_SESSION), test.dependencies());
    test.pool.stopCoordinator();

    const second = await launchCoordinator(test.request(SECOND_SESSION), test.dependencies());
    const [reconciliation] = reconciliationsOf(second);
    expect(reconciliation?.sessionId).toBe(FIRST_SESSION);
    expect(reconciliation?.workspace.outcome).toBe("closed");
    expect(reconciliation?.resources.outcome).toBe("released");
    expect(test.pool.returnedPaths).toContain(first.worktree.path);

    expect(test.pool.coordinatorLeases()).toHaveLength(1);
    expect(test.pool.panes.size).toBe(1);
    expect(second.worktree.leaseId).not.toBe(first.worktree.leaseId);
    expect(await readCoordinatorRecord(recordPath(test.home, FIRST_SESSION, test.repo))).toBe(
      undefined,
    );
    const kept = await readCoordinatorRecord(recordPath(test.home, SECOND_SESSION, test.repo));
    expect(kept?.worktree.leaseId).toBe(second.worktree.leaseId);
    expect(kept?.endpoint.paneId).toBe(second.paneId);

    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
    expect(test.pool.returnedPaths).not.toContain(test.taskWorktree);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a dirty coordinator worktree from another session is retained, never released", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request(FIRST_SESSION), test.dependencies());
    test.pool.stopCoordinator();
    const previousState = test.pool.worktrees.get(first.worktree.path);
    if (previousState === undefined) throw new Error("the fake pool lost the coordinator worktree");
    previousState.dirty = true;

    const second = await launchCoordinator(test.request(SECOND_SESSION), test.dependencies());
    const [reconciliation] = reconciliationsOf(second);
    expect(reconciliation?.resources.outcome).toBe("retained");
    expect(reconciliation?.resources.reason).toContain("uncommitted changes");
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.leases.has(first.worktree.leaseId)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a live coordinator in another session is never duplicated or stolen", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request(FIRST_SESSION), test.dependencies());

    await expect(
      launchCoordinator(test.request(SECOND_SESSION, test.repoLink), test.dependencies()),
    ).rejects.toThrow(
      new RegExp(
        `already runs a coordinator[\\s\\S]*${FIRST_SESSION}[\\s\\S]*${PARALLEL_COORDINATORS_VARIABLE}`,
        "u",
      ),
    );

    expect(test.pool.coordinatorLeases()).toHaveLength(1);
    expect(test.pool.panes.size).toBe(1);
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(await readCoordinatorRecord(recordPath(test.home, SECOND_SESSION, test.repo))).toBe(
      undefined,
    );
    const kept = await readCoordinatorRecord(recordPath(test.home, FIRST_SESSION, test.repo));
    expect(kept?.worktree.leaseId).toBe(first.worktree.leaseId);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a coordinator record stored under a foreign session directory is refused and quarantined", async () => {
  const test = await fixture();
  try {
    const path = await writeStoredRecord(
      test.home,
      "tandem-elsewhere",
      ghostRecord(test.repo, test.poolRoot),
      test.repo,
    );

    await expect(
      launchCoordinator(test.request(SECOND_SESSION), test.dependencies()),
    ).rejects.toThrow(/does not belong to[\s\S]*Quarantine record/u);

    const quarantined = await listCoordinatorQuarantineRecords(test.home);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.stage).toBe("exclusivity");
    expect(quarantined[0]?.sessionId).toBe("tandem-ghost");
    expect(quarantined[0]?.lease.leaseId).toBe("lease-ghost");
    expect(quarantined[0]?.endpoint?.paneId).toBe("pane-ghost");

    // The refused launch allocated nothing and left the unexplained record exactly where it was.
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    const discovery = await discoverCoordinatorRecords({ home: test.home, repoPath: test.repo });
    expect(discovery.records.map((found) => found.path)).toEqual([path]);
    expect(discovery.records[0]?.placement).toBe("foreign-directory");
    expect(discovery.records[0]?.sessionId).toBe("tandem-ghost");
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("an unreadable coordinator record for the repository refuses the launch", async () => {
  const test = await fixture();
  try {
    const directory = registrySessionDirectory(test.home, "tandem-elsewhere");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${digest(test.repo)}.json`);
    await writeFile(path, "{ not json", { encoding: "utf8", mode: 0o600 });

    await expect(
      launchCoordinator(test.request(SECOND_SESSION), test.dependencies()),
    ).rejects.toThrow(/could not be read/u);
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    expect((await discoverCoordinatorRecords({ home: test.home })).unreadable).toHaveLength(1);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("parallel coordinators need the explicit opt-in and are refused without it", async () => {
  const test = await fixture();
  try {
    await launchCoordinator(test.request(FIRST_SESSION), test.dependencies());
    await expect(
      launchCoordinator(test.request(SECOND_SESSION), test.dependencies()),
    ).rejects.toThrow(/already runs a coordinator/u);

    const second = await launchCoordinator(
      test.request(SECOND_SESSION),
      test.dependencies({ [PARALLEL_COORDINATORS_VARIABLE]: "1" }),
    );
    expect(second.paneId).toBeDefined();
    expect(reconciliationsOf(second)).toHaveLength(0);
    expect(test.pool.coordinatorLeases()).toHaveLength(2);
    expect(test.pool.panes.size).toBe(2);
    const discovery = await discoverCoordinatorRecords({ home: test.home, repoPath: test.repo });
    expect(discovery.records.map((found) => found.sessionId).sort()).toEqual(
      [FIRST_SESSION, SECOND_SESSION].sort(),
    );
    expect(discovery.records.every((found) => found.placement === "session-directory")).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});
