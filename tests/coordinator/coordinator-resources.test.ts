import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  launchCoordinator,
} from "../../src/coordinator/launch.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../src/coordinator/registry.ts";
import {
  type CoordinatorCheckoutObservation,
  decideCoordinatorReplacement,
  listCoordinatorQuarantineRecords,
} from "../../src/coordinator/resources.ts";
import { restartCoordinator } from "../../src/coordinator/restart.ts";
import {
  FIRST_HEAD,
  fakePool,
  type Pool,
  SECOND_HEAD,
  TASK_LEASE_ID,
  THIRD_HEAD,
} from "./fake-pool.ts";

const SESSION_ID = "resources-session";

type Fixture = Readonly<{
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly poolRoot: string;
  readonly decoy: string;
  readonly taskWorktree: string;
  readonly pool: Pool;
  readonly request: CoordinatorLaunchRequest;
  readonly dependencies: CoordinatorLaunchDependencies;
}>;

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-resources-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const poolRoot = join(root, "pool");
  const decoy = join(root, "decoy");
  const taskWorktree = join(poolRoot, "task-worktree");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(taskWorktree, { recursive: true });
  await mkdir(decoy, { recursive: true });
  const model = defaultPolicy().models.coordinator;
  const configPath = "/tandem/src/worker-config.yml";
  const extensionPath = "/tandem/src/extension.ts";
  const pool = fakePool({ repo, poolRoot, taskWorktreePath: taskWorktree });
  let quarantineIds = 0;
  return {
    root,
    repo,
    home,
    poolRoot,
    decoy,
    taskWorktree,
    pool,
    request: {
      cwd: repo,
      repo,
      home,
      poolRoot,
      sessionId: SESSION_ID,
      model,
      configPath,
      extensionPath,
      continueSession: false,
      headless: true,
      noAttach: true,
      sourceHead: FIRST_HEAD,
    },
    dependencies: {
      run: pool.run,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("headless launches never attach interactively");
      },
      sleep: async () => undefined,
      processEnvironment: {},
      clock: () => "2030-01-02T03:04:05.000Z",
      newId: () => {
        quarantineIds += 1;
        return `quarantine-${quarantineIds}`;
      },
    },
  };
}

function observedCheckout(
  values: Partial<Extract<CoordinatorCheckoutObservation, { status: "observed" }>> = {},
): CoordinatorCheckoutObservation {
  return {
    status: "observed",
    head: FIRST_HEAD,
    branch: "tandem/coordinator-a",
    dirty: false,
    unmerged: false,
    ...values,
  };
}

function previousRecord(
  values: Partial<{ head: string; branch: string; leaseHolder: string }> = {},
) {
  return {
    schemaVersion: 1 as const,
    repoPath: "/repo",
    endpoint: {
      sessionId: SESSION_ID,
      workspaceId: "workspace-a",
      tabId: "tab-a",
      paneId: "pane-a",
      role: "coordinator" as const,
      generation: 0,
    },
    worktree: {
      root: "/pool",
      path: "/pool/coordinator-a",
      name: "coordinator-a",
      baseHead: values.head ?? FIRST_HEAD,
      branch: values.branch ?? "tandem/coordinator-a",
      leaseId: "lease-a",
      leaseHolder: values.leaseHolder ?? "coordinator:holder",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    command: ["omp"],
  };
}

test("the replacement decision reuses, releases, retains, or quarantines without guessing", () => {
  expect(
    decideCoordinatorReplacement({
      previous: undefined,
      paneRetirement: undefined,
      checkout: undefined,
      requestedSourceHead: FIRST_HEAD,
      replacementLeaseHolder: "coordinator:holder",
    }).kind,
  ).toBe("allocate");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "closed" },
      checkout: observedCheckout(),
      requestedSourceHead: FIRST_HEAD,
      replacementLeaseHolder: "coordinator:holder",
    }).kind,
  ).toBe("reuse");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "already-clear" },
      checkout: observedCheckout(),
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("release");

  const dirty = decideCoordinatorReplacement({
    previous: previousRecord(),
    paneRetirement: { outcome: "closed" },
    checkout: observedCheckout({ dirty: true }),
    requestedSourceHead: SECOND_HEAD,
    replacementLeaseHolder: "coordinator:other",
  });
  expect(dirty.kind).toBe("retain");
  expect(dirty.reason).toContain("uncommitted changes");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "closed" },
      checkout: observedCheckout({ unmerged: true }),
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("retain");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "retained", reason: "extra panes still share this workspace" },
      checkout: observedCheckout(),
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("retain");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "quarantined", reason: "pane moved" },
      checkout: observedCheckout(),
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("quarantine");

  const foreignBranch = decideCoordinatorReplacement({
    previous: previousRecord(),
    paneRetirement: { outcome: "closed" },
    checkout: observedCheckout({ branch: "feature/someone-elses-work" }),
    requestedSourceHead: SECOND_HEAD,
    replacementLeaseHolder: "coordinator:other",
  });
  expect(foreignBranch.kind).toBe("quarantine");
  expect(foreignBranch.reason).toContain("recorded lease branch");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "closed" },
      checkout: observedCheckout({ head: THIRD_HEAD }),
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("quarantine");

  expect(
    decideCoordinatorReplacement({
      previous: previousRecord(),
      paneRetirement: { outcome: "closed" },
      checkout: { status: "unreadable", detail: "git exploded" },
      requestedSourceHead: SECOND_HEAD,
      replacementLeaseHolder: "coordinator:other",
    }).kind,
  ).toBe("quarantine");
});

test("repeated launch and restart cycles keep one coordinator lease and one pool worktree", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request, test.dependencies);
    expect(test.pool.coordinatorLeases()).toHaveLength(1);

    test.pool.stopCoordinator();
    const second = await launchCoordinator(
      { ...test.request, sourceHead: SECOND_HEAD },
      test.dependencies,
    );
    expect(second.previousResources?.outcome).toBe("released");
    expect(second.worktree.leaseId).not.toBe(first.worktree.leaseId);
    expect(test.pool.coordinatorLeases()).toHaveLength(1);

    test.pool.setRepoHead(THIRD_HEAD);
    const restarted = await restartCoordinator(
      { ...test.request, sourceHead: SECOND_HEAD },
      test.dependencies,
    );
    expect(restarted.restarted).toBe(true);
    expect(restarted.previousResources?.outcome).toBe("released");
    expect(test.pool.coordinatorLeases()).toHaveLength(1);

    // One pooled coordinator worktree was recycled across all three cycles.
    const coordinatorWorktrees = [...test.pool.worktrees.keys()].filter(
      (path) => path !== test.taskWorktree && path !== resolve(test.repo),
    );
    expect(coordinatorWorktrees).toHaveLength(1);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
    expect(test.pool.returnedPaths).not.toContain(test.taskWorktree);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);

    const record = await readCoordinatorRecord(recordPath(test.home, SESSION_ID, test.repo));
    expect(record?.worktree.leaseId).toBe(restarted.worktree.leaseId);
    expect(record?.endpoint.paneId).toBe(restarted.paneId);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a failure after lease acquisition releases the new lease and leaves nothing behind", async () => {
  const test = await fixture();
  try {
    await expect(
      launchCoordinator({ ...test.request, sourceRepo: test.decoy }, test.dependencies),
    ).rejects.toThrow(/does not match owned lease worktree/u);
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
    expect(test.pool.returnedPaths).not.toContain(test.taskWorktree);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a failed workspace creation releases the new lease", async () => {
  const test = await fixture();
  try {
    test.pool.setFailure("workspace-create");
    await expect(launchCoordinator(test.request, test.dependencies)).rejects.toThrow(
      /workspace create refused/u,
    );
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a failed pane start closes the new pane and releases the new lease", async () => {
  const test = await fixture();
  try {
    test.pool.setFailure("pane-run");
    await expect(launchCoordinator(test.request, test.dependencies)).rejects.toThrow(
      /pane run refused/u,
    );
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    expect(test.pool.workspaces.size).toBe(0);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("an unprovable coordinator quarantines the new lease instead of releasing it", async () => {
  const test = await fixture();
  try {
    test.pool.setFailure("ownership");
    await expect(launchCoordinator(test.request, test.dependencies)).rejects.toThrow(
      /quarantine record/u,
    );
    const quarantined = await listCoordinatorQuarantineRecords(test.home);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.stage).toBe("rollback");
    expect(quarantined[0]?.lease.leaseId).toBe(
      test.pool.coordinatorLeases()[0]?.leaseId ?? "missing",
    );
    expect(quarantined[0]?.reason).toContain("did not become owned");
    expect(quarantined[0]?.endpoint?.paneId).toBeDefined();
    // The lease stays put, tracked by the quarantine note rather than silently discarded.
    expect(test.pool.coordinatorLeases()).toHaveLength(1);
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("a dirty previous coordinator worktree is retained and reported, never released", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request, test.dependencies);
    test.pool.stopCoordinator();
    const previousState = test.pool.worktrees.get(first.worktree.path);
    if (previousState === undefined) throw new Error("fake pool lost the coordinator worktree");
    previousState.dirty = true;

    const second = await launchCoordinator(
      { ...test.request, sourceHead: SECOND_HEAD },
      test.dependencies,
    );
    expect(second.previousResources?.outcome).toBe("retained");
    expect(second.previousResources?.reason).toContain("uncommitted changes");
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.leases.has(first.worktree.leaseId)).toBe(true);
    expect(test.pool.coordinatorLeases()).toHaveLength(2);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("an unmerged previous coordinator worktree is retained and reported", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request, test.dependencies);
    test.pool.stopCoordinator();
    const previousState = test.pool.worktrees.get(first.worktree.path);
    if (previousState === undefined) throw new Error("fake pool lost the coordinator worktree");
    previousState.unmerged = true;

    const second = await launchCoordinator(
      { ...test.request, sourceHead: SECOND_HEAD },
      test.dependencies,
    );
    expect(second.previousResources?.outcome).toBe("retained");
    expect(second.previousResources?.reason).toContain("unmerged paths");
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.leases.has(first.worktree.leaseId)).toBe(true);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});

test("an unchanged source commit reuses the previous coordinator lease and worktree", async () => {
  const test = await fixture();
  try {
    const first = await launchCoordinator(test.request, test.dependencies);
    test.pool.stopCoordinator();
    const second = await launchCoordinator(test.request, test.dependencies);
    expect(second.previousResources?.outcome).toBe("reused");
    expect(second.worktree.leaseId).toBe(first.worktree.leaseId);
    expect(second.worktree.path).toBe(first.worktree.path);
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.coordinatorLeases()).toHaveLength(1);
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});
