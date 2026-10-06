import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import type {
  CommandRequest,
  Endpoint,
  ResolvedPolicy,
  WorktreeLease,
} from "../../src/contracts.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  launchCoordinator,
} from "../../src/coordinator/launch.ts";
import { listCoordinatorQuarantineRecords } from "../../src/coordinator/quarantine.ts";
import {
  planTandemReconciliation,
  type ReconcileReport,
  type ReconcileReportEntry,
  reconcileTandemResources,
  scanTandemResources,
} from "../../src/coordinator/reconcile.ts";
import { digest, recordPath, registrySessionDirectory } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { quarantineCoordinatorLease } from "../../src/coordinator/resources.ts";
import { runTerminal } from "../../src/main.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { FIRST_HEAD, fakePool, type Pool, TASK_LEASE_ID } from "./fake-pool.ts";

const FIRST_SESSION = "tandem";
const SECOND_SESSION = "tandem-fresh";
const TIMESTAMP = "2030-01-02T03:04:05.000Z";
const ORPHAN_LEASE_ID = "lease-orphan";
const ORPHAN_HOLDER = "coordinator:abandoned:session:head";

type Fixture = Readonly<{
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly poolRoot: string;
  readonly pool: Pool;
  readonly launch: (sessionId: string) => Promise<void>;
  readonly reconcile: (
    apply: boolean,
    discard?: boolean,
    freeSuperseded?: boolean,
  ) => Promise<ReconcileReport>;
}>;

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-reconcile-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const poolRoot = join(root, "pool");
  const taskWorktree = join(poolRoot, "task-worktree");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.toml"), 'terminal = "herdr"\n', "utf8");
  await mkdir(taskWorktree, { recursive: true });
  const pool = fakePool({ repo, poolRoot, taskWorktreePath: taskWorktree });
  const model = defaultPolicy().models.coordinator;
  let quarantineIds = 0;
  const request = (sessionId: string): CoordinatorLaunchRequest => ({
    cwd: repo,
    repo,
    home,
    poolRoot,
    sessionId,
    model,
    continueSession: false,
    headless: true,
    noAttach: true,
    sourceHead: FIRST_HEAD,
  });
  const dependencies: CoordinatorLaunchDependencies = {
    run: pool.run,
    terminal: terminalBackend(pool.run, { terminal: "herdr" }),
    startPersistent: async () => undefined,
    runInteractive: async () => {
      throw new Error("headless launches never attach interactively");
    },
    sleep: async () => undefined,
    processEnvironment: {},
    clock: () => TIMESTAMP,
    newId: () => {
      quarantineIds += 1;
      return `quarantine-${quarantineIds}`;
    },
  };
  return {
    root,
    repo,
    home,
    poolRoot,
    pool,
    launch: async (sessionId) => {
      await launchCoordinator(request(sessionId), dependencies);
    },
    reconcile: async (apply, discard = false, freeSuperseded = false) =>
      reconcileTandemResources({
        run: pool.run,
        terminal: terminalBackend(pool.run, { terminal: "herdr" }),
        home,
        poolRoot,
        repoPaths: [repo],
        apply,
        discard,
        freeSuperseded,
        clock: () => TIMESTAMP,
        newId: () => {
          quarantineIds += 1;
          return `quarantine-${quarantineIds}`;
        },
      }),
  };
}

async function withFixture(action: (test: Fixture) => Promise<void>): Promise<void> {
  const created = await fixture();
  try {
    await action(created);
  } finally {
    await rm(created.root, { recursive: true, force: true });
  }
}

function entries(
  list: readonly ReconcileReportEntry[],
  kind: string,
): readonly ReconcileReportEntry[] {
  return list.filter((entry) => entry.kind === kind);
}

function mutating(request: CommandRequest): boolean {
  const argv = request.argv;
  if (argv[0] === "git") return argv.includes("switch") || argv.includes("commit");
  if (argv[0] === "treehouse") return argv.includes("get") || argv.includes("return");
  if (argv[0] !== "herdr") return true;
  return (
    argv.includes("close") ||
    argv.includes("run") ||
    argv.includes("create") ||
    argv.includes("rename") ||
    argv.includes("send")
  );
}

/** Seeds an abandoned coordinator lease the pool still holds and no record accounts for. */
async function seedOrphanedLease(test: Fixture, overrides: Partial<{ dirty: boolean }> = {}) {
  const path = join(test.poolRoot, "coordinator-orphan");
  await mkdir(path, { recursive: true });
  test.pool.leases.set(ORPHAN_LEASE_ID, {
    leaseId: ORPHAN_LEASE_ID,
    leaseHolder: ORPHAN_HOLDER,
    path,
  });
  test.pool.worktrees.set(path, {
    head: FIRST_HEAD,
    branch: "tandem/coordinator-orphan",
    dirty: overrides.dirty ?? false,
    unmerged: false,
  });
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
      leasedAt: TIMESTAMP,
    },
    command: ["omp", "--model", "ghost"],
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

const scoutPolicy: ResolvedPolicy = {
  config: defaultPolicy(),
  guidance: { implementation: [], validation: [], review: [] },
};

/** Seeds one completed scout whose pane and lease an earlier coordinator never released. */
async function seedPendingScout(
  test: Fixture,
): Promise<Readonly<{ lease: WorktreeLease; endpoint: Endpoint }>> {
  const worktreePath = join(test.poolRoot, "scout-worktree");
  await mkdir(worktreePath, { recursive: true });
  const lease: WorktreeLease = {
    root: test.poolRoot,
    path: worktreePath,
    name: "tandem-scout-1",
    baseHead: FIRST_HEAD,
    branch: "tandem/scout-1",
    leaseId: "lease-scout",
    leaseHolder: "task:scout-1",
    leasedAt: TIMESTAMP,
  };
  const endpoint: Endpoint = {
    terminal: "herdr" as const,
    sessionId: FIRST_SESSION,
    workspaceId: "workspace-scout",
    tabId: "tab-scout",
    paneId: "pane-scout",
    role: "scout",
    generation: 0,
  };
  test.pool.leases.set(lease.leaseId, {
    leaseId: lease.leaseId,
    leaseHolder: lease.leaseHolder,
    path: lease.path,
  });
  test.pool.worktrees.set(lease.path, {
    head: lease.baseHead,
    branch: lease.branch,
    dirty: false,
    unmerged: false,
  });
  test.pool.panes.set(endpoint.paneId, {
    sessionId: endpoint.sessionId,
    paneId: endpoint.paneId,
    tabId: endpoint.tabId,
    workspaceId: endpoint.workspaceId,
    cwd: lease.path,
    omp: undefined,
  });
  const reportPath = join(test.home, "reports", "scout-1.md");
  await mkdir(join(test.home, "reports"), { recursive: true });
  await writeFile(reportPath, "Outcome: completed\n", "utf8");
  const store = createTaskStore({
    directory: join(test.home, "tasks"),
    clock: () => TIMESTAMP,
    idFactory: () => "scout-1",
  });
  const created = await store.create({
    id: "scout-1",
    repoPath: test.repo,
    kind: "scout",
    objective: "map the launch path",
    acceptanceCriteria: ["report entry points"],
    surfaces: ["service"],
    policy: scoutPolicy,
    researchContinuation: { schemaVersion: 1, disposition: "report-only", selectedBy: "explicit" },
  });
  const started = await store.update(created.id, created.revision, (task) =>
    transitionTask(
      task,
      { type: "start", worktree: lease, endpoints: [endpoint] },
      { now: TIMESTAMP, notificationId: "start-1" },
    ),
  );
  const completed = await store.update(started.id, started.revision, (task) =>
    transitionTask(
      task,
      { type: "scout-report-complete", reportPath, generation: 0 },
      { now: TIMESTAMP, notificationId: "complete-1" },
    ),
  );
  await writeRuntimeState(runtimeFile(test.home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: completed.id,
        sourceCheckpoint: {
          head: FIRST_HEAD,
          base: FIRST_HEAD,
          diff: "",
          dirty: false,
          unmerged: false,
        },
        taskName: lease.name,
        worktree: lease,
        endpoints: [endpoint],
        jobs: [],
      },
    ],
    presentations: [],
  });
  return { lease, endpoint };
}

/**
 * Seeds an implementation whose cleanup never settled; dirty unless told otherwise. `otherBranch`
 * adds a second task holding that branch, so the first task's commits can be contained in it.
 */
async function seedPendingImplementation(
  test: Fixture,
  stage: "cancelled" | "blocked" = "cancelled",
  options: Readonly<{ dirty?: boolean; otherBranch?: string }> = {},
): Promise<WorktreeLease> {
  const worktreePath = join(test.poolRoot, "implementation-worktree");
  await mkdir(worktreePath, { recursive: true });
  const lease: WorktreeLease = {
    root: test.poolRoot,
    path: worktreePath,
    name: "tandem-implementation-1",
    baseHead: FIRST_HEAD,
    branch: "tandem/implementation-1",
    leaseId: "lease-implementation",
    leaseHolder: "task:implementation-1",
    leasedAt: TIMESTAMP,
  };
  test.pool.leases.set(lease.leaseId, {
    leaseId: lease.leaseId,
    leaseHolder: lease.leaseHolder,
    path: lease.path,
  });
  const endpoint: Endpoint = {
    terminal: "herdr" as const,
    sessionId: FIRST_SESSION,
    workspaceId: "workspace-implementation",
    tabId: "tab-implementation",
    paneId: "pane-implementation",
    role: "implementer",
    generation: 0,
  };
  test.pool.panes.set(endpoint.paneId, {
    sessionId: endpoint.sessionId,
    paneId: endpoint.paneId,
    tabId: endpoint.tabId,
    workspaceId: endpoint.workspaceId,
    cwd: lease.path,
    omp: undefined,
  });
  test.pool.worktrees.set(lease.path, {
    head: FIRST_HEAD,
    branch: lease.branch,
    dirty: options.dirty ?? true,
    unmerged: false,
  });

  const store = createTaskStore({
    directory: join(test.home, "tasks"),
    clock: () => TIMESTAMP,
    idFactory: () => "implementation-1",
  });
  const created = await store.create({
    id: "implementation-1",
    repoPath: test.repo,
    kind: "implementation",
    objective: "implement the approved change",
    acceptanceCriteria: ["the change is complete"],
    surfaces: ["service"],
    policy: scoutPolicy,
  });
  const queued = await store.update(created.id, created.revision, (task) =>
    transitionTask(
      task,
      { type: "approve" },
      { now: TIMESTAMP, notificationId: "implementation-approve-1" },
    ),
  );
  const started = await store.update(queued.id, queued.revision, (task) =>
    transitionTask(
      task,
      { type: "start", worktree: lease, endpoints: [endpoint] },
      { now: TIMESTAMP, notificationId: "implementation-start-1" },
    ),
  );
  const settled = await store.update(started.id, started.revision, (task) =>
    transitionTask(
      task,
      stage === "cancelled"
        ? { type: "cancel", reason: "superseded" }
        : { type: "block", reason: "awaiting coordinator decision" },
      {
        now: TIMESTAMP,
        notificationId:
          stage === "cancelled" ? "implementation-cancel-1" : "implementation-block-1",
      },
    ),
  );

  const checkpoint = {
    head: FIRST_HEAD,
    base: FIRST_HEAD,
    diff: "",
    dirty: false,
    unmerged: false,
  };
  const other =
    options.otherBranch === undefined
      ? []
      : [
          {
            schemaVersion: 1 as const,
            taskId: (
              await store.create({
                id: "e2c0fbb5-other",
                repoPath: test.repo,
                kind: "implementation",
                objective: "the follow-up that carries the same commits",
                acceptanceCriteria: ["the change is complete"],
                surfaces: ["service"],
                policy: scoutPolicy,
              })
            ).id,
            sourceCheckpoint: checkpoint,
            taskName: "tandem-other",
            worktree: {
              ...lease,
              path: join(test.poolRoot, "other-worktree"),
              name: "tandem-other",
              branch: options.otherBranch,
              leaseId: "lease-other",
              leaseHolder: "task:other",
            },
            endpoints: [],
            jobs: [],
          },
        ];
  await writeRuntimeState(runtimeFile(test.home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: settled.id,
        sourceCheckpoint: checkpoint,
        taskName: lease.name,
        worktree: lease,
        endpoints: [endpoint],
        jobs: [],
      },
      ...other,
    ],
    presentations: [],
  });
  return lease;
}

const OTHER_HEAD = "a".repeat(40);
const MAIN_HEAD = "5".repeat(40);

/**
 * Scripts the repository's history: main is at MAIN_HEAD, the other task's branch at OTHER_HEAD,
 * and the cancelled task's one commit (FIRST_HEAD) is carried by that branch only when `carried`.
 */
function scriptHistory(test: Fixture, carried: boolean): void {
  const fail = { code: 1, stdout: "", stderr: "" };
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const refs: Readonly<Record<string, string>> = {
    "HEAD^{commit}": MAIN_HEAD,
    "refs/heads/tandem/other^{commit}": OTHER_HEAD,
  };
  test.pool.setGitScript((args) => {
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      const commit = refs[args.at(-1) ?? ""];
      return commit === undefined ? fail : ok(`${commit}\n`);
    }
    if (args[0] === "merge-base") return fail;
    if (args[0] === "rev-list" && args.includes("--not")) return ok(`${FIRST_HEAD} ${MAIN_HEAD}\n`);
    if (args[0] === "rev-list" && args.includes("--cherry-mark")) {
      return ok(carried && args.at(-1)?.startsWith(OTHER_HEAD) ? "" : `+${FIRST_HEAD}\n`);
    }
    return undefined;
  });
}

/** Whether any command returned this lease, and whether any command touched a branch ref. */
function returnOf(test: Fixture, lease: WorktreeLease): CommandRequest | undefined {
  return test.pool.calls.find(
    (call) =>
      call.argv[0] === "treehouse" &&
      call.argv.includes("return") &&
      call.argv.includes(lease.leaseId),
  );
}

function branchChanges(test: Fixture): readonly CommandRequest[] {
  return test.pool.calls.filter(
    (call) =>
      call.argv[0] === "git" &&
      (call.argv.includes("branch") || call.argv.includes("update-ref")) &&
      call.argv.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete"),
  );
}

test("the plan classifies each observed resource without touching any of them", () => {
  const plan = planTandemReconciliation({
    home: "/home",
    coordinators: [],
    leases: [
      {
        repoPath: "/repo",
        poolRoot: "/pool",
        leaseId: "lease-task",
        leaseHolder: "task:implement-1",
        leasedAt: TIMESTAMP,
        name: "tandem-task-1",
        path: "/pool/task-1",
        checkout: undefined,
      },
      {
        repoPath: "/repo",
        poolRoot: "/pool",
        leaseId: ORPHAN_LEASE_ID,
        leaseHolder: ORPHAN_HOLDER,
        leasedAt: TIMESTAMP,
        name: "coordinator-orphan",
        path: "/pool/coordinator-orphan",
        checkout: {
          status: "observed",
          head: FIRST_HEAD,
          branch: "tandem/coordinator-orphan",
          dirty: false,
          unmerged: false,
        },
      },
      {
        repoPath: "/repo",
        poolRoot: "/pool",
        leaseId: "lease-dirty",
        leaseHolder: "coordinator:dirty",
        leasedAt: TIMESTAMP,
        name: "coordinator-dirty",
        path: "/pool/coordinator-dirty",
        checkout: {
          status: "observed",
          head: FIRST_HEAD,
          branch: "tandem/coordinator-dirty",
          dirty: true,
          unmerged: false,
        },
      },
    ],
    scouts: [{ taskId: "scout-1", repoPath: "/repo", reason: "still holds child resources" }],
    unreadable: [{ path: "/home/coordinator-registry/a/b.json", reason: "not valid JSON" }],
    quarantines: [],
    settledQuarantineIds: [],
    failures: [],
    nativeOpens: [],
    quarantinedPanes: [],
  });
  expect(plan.items.map((item) => item.action)).toEqual([
    "retain",
    "clean",
    "retain",
    "clean",
    "quarantine",
  ]);
  expect(plan.items[0]?.reason).toContain("not a Tandem coordinator");
  expect(plan.items[2]?.reason).toContain("uncommitted changes");
});

test("a stopped coordinator is reported before it is closed, released, and forgotten", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    const launched = [...test.pool.coordinatorLeases()][0];
    if (launched === undefined) throw new Error("the launch acquired no coordinator lease");
    test.pool.stopCoordinator();

    const dry = await test.reconcile(false);
    expect(dry.mode).toBe("dry-run");
    expect(entries(dry.cleaned, "coordinator")).toHaveLength(1);
    expect(dry.cleaned[0]?.sessionId).toBe(FIRST_SESSION);
    expect(dry.cleaned[0]?.reason).toContain("is stopped");
    expect(test.pool.coordinatorLeases()).toHaveLength(1);
    expect(test.pool.panes.size).toBe(1);
    expect(test.pool.returnedPaths).toHaveLength(0);

    const applied = await test.reconcile(true);
    expect(applied.mode).toBe("applied");
    expect(entries(applied.cleaned, "coordinator")).toHaveLength(1);
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    expect(test.pool.returnedPaths).toContain(launched.path);
    expect(await readCoordinatorRecord(recordPath(test.home, FIRST_SESSION, test.repo))).toBe(
      undefined,
    );
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);

    const again = await test.reconcile(true);
    expect(again.cleaned).toHaveLength(0);
  });
});

test("a coordinator record whose pane is gone is still settled through its owners", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    const launched = [...test.pool.coordinatorLeases()][0];
    if (launched === undefined) throw new Error("the launch acquired no coordinator lease");
    for (const paneId of [...test.pool.panes.keys()]) test.pool.panes.delete(paneId);

    const applied = await test.reconcile(true);
    expect(entries(applied.cleaned, "coordinator")).toHaveLength(1);
    expect(test.pool.returnedPaths).toContain(launched.path);
    expect(await readCoordinatorRecord(recordPath(test.home, FIRST_SESSION, test.repo))).toBe(
      undefined,
    );
  });
});

test("a live coordinator and its lease are retained, never closed or released", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);

    const applied = await test.reconcile(true);
    expect(applied.cleaned).toHaveLength(0);
    const retained = entries(applied.retained, "coordinator");
    expect(retained).toHaveLength(1);
    expect(retained[0]?.reason).toContain(FIRST_SESSION);
    expect(test.pool.coordinatorLeases()).toHaveLength(1);
    expect(test.pool.panes.size).toBe(1);
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(
      await readCoordinatorRecord(recordPath(test.home, FIRST_SESSION, test.repo)),
    ).toBeDefined();
  });
});

test("a dirty coordinator worktree is retained with its reason and keeps its pane", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    const launched = [...test.pool.coordinatorLeases()][0];
    if (launched === undefined) throw new Error("the launch acquired no coordinator lease");
    test.pool.stopCoordinator();
    const worktree = test.pool.worktrees.get(launched.path);
    if (worktree === undefined) throw new Error("the fake pool lost the coordinator worktree");
    worktree.dirty = true;

    const dry = await test.reconcile(false);
    expect(dry.cleaned).toHaveLength(0);
    expect(entries(dry.retained, "coordinator")[0]?.reason).toContain("uncommitted changes");

    const applied = await test.reconcile(true);
    expect(entries(applied.retained, "coordinator")[0]?.reason).toContain("uncommitted changes");
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.panes.size).toBe(1);
    expect(test.pool.leases.has(launched.leaseId)).toBe(true);
  });
});

test("a record Tandem cannot place is quarantined once, closing and releasing nothing", async () => {
  await withFixture(async (test) => {
    const path = await writeStoredRecord(
      test.home,
      "tandem-elsewhere",
      ghostRecord(test.repo, test.poolRoot),
      test.repo,
    );

    const dry = await test.reconcile(false);
    expect(dry.quarantined.map((entry) => entry.path)).toContain(path);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);

    const applied = await test.reconcile(true);
    expect(entries(applied.quarantined, "coordinator")[0]?.reason).toContain("does not belong to");
    const notes = await listCoordinatorQuarantineRecords(test.home);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.lease.leaseId).toBe("lease-ghost");
    expect(test.pool.coordinatorLeases()).toHaveLength(0);
    expect(test.pool.panes.size).toBe(0);
    expect(test.pool.returnedPaths).toHaveLength(0);

    await test.reconcile(true);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(1);
    expect(await readCoordinatorRecord(path)).toBeDefined();
  });
});

test("a note whose lease was since returned is retired once, and repeated notes do not pile up", async () => {
  await withFixture(async (test) => {
    const ghost = ghostRecord(test.repo, test.poolRoot);
    let id = 0;
    const note = () =>
      quarantineCoordinatorLease({
        home: test.home,
        sessionId: "tandem",
        repoPath: test.repo,
        stage: "replacement",
        reason: "previous coordinator checkout could not be read",
        lease: ghost.worktree as WorktreeLease,
        clock: () => TIMESTAMP,
        newId: () => `note-${++id}`,
      });
    await note();
    await note();
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(1);

    const dry = await test.reconcile(false);
    expect(entries(dry.cleaned, "quarantine-note")).toHaveLength(1);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(1);

    const applied = await test.reconcile(true);
    expect(entries(applied.cleaned, "quarantine-note")).toHaveLength(1);
    expect(await listCoordinatorQuarantineRecords(test.home)).toHaveLength(0);

    const again = await test.reconcile(true);
    expect(entries(again.cleaned, "quarantine-note")).toHaveLength(0);
    expect(entries(again.quarantined, "quarantine-note")).toHaveLength(0);
  });
});

test("an orphaned clean coordinator lease is returned by its exact identity", async () => {
  await withFixture(async (test) => {
    const path = await seedOrphanedLease(test);

    const dry = await test.reconcile(false);
    expect(entries(dry.cleaned, "worktree-lease")[0]?.id).toBe(ORPHAN_LEASE_ID);
    expect(test.pool.leases.has(ORPHAN_LEASE_ID)).toBe(true);

    const applied = await test.reconcile(true);
    expect(entries(applied.cleaned, "worktree-lease")[0]?.path).toBe(path);
    expect(test.pool.leases.has(ORPHAN_LEASE_ID)).toBe(false);
    expect(test.pool.returnedPaths).toContain(path);
    const returned = test.pool.calls.filter(
      (call) => call.argv[0] === "treehouse" && call.argv.includes("return"),
    );
    expect(returned[0]?.argv).toContain(ORPHAN_LEASE_ID);
    expect(returned[0]?.argv).toContain(ORPHAN_HOLDER);
    expect(test.pool.leases.has(TASK_LEASE_ID)).toBe(true);
    expect(test.pool.returnedPaths).not.toContain(join(test.poolRoot, "task-worktree"));
  });
});

test("an orphaned coordinator lease a live process still runs in is kept, not returned", async () => {
  await withFixture(async (test) => {
    await seedOrphanedLease(test);
    const lease = test.pool.leases.get(ORPHAN_LEASE_ID);
    if (lease === undefined) throw new Error("seeded lease missing");
    test.pool.leases.set(ORPHAN_LEASE_ID, { ...lease, processes: [{ pid: 42, name: "herdr" }] });

    const applied = await test.reconcile(true);
    const retained = entries(applied.retained, "worktree-lease").find(
      (entry) => entry.id === ORPHAN_LEASE_ID,
    );
    expect(retained?.reason).toContain("a running process is using this worktree (pid 42 herdr)");
    expect(test.pool.leases.has(ORPHAN_LEASE_ID)).toBe(true);
    expect(
      test.pool.calls.some((call) => call.argv[0] === "treehouse" && call.argv.includes("return")),
    ).toBe(false);
  });
});

test("a dirty orphaned coordinator lease is retained and reported", async () => {
  await withFixture(async (test) => {
    await seedOrphanedLease(test, { dirty: true });

    const applied = await test.reconcile(true);
    expect(applied.cleaned).toHaveLength(0);
    const retained = entries(applied.retained, "worktree-lease").find(
      (entry) => entry.id === ORPHAN_LEASE_ID,
    );
    expect(retained?.reason).toContain("uncommitted changes");
    expect(test.pool.leases.has(ORPHAN_LEASE_ID)).toBe(true);
  });
});

test("pending scout cleanup is finished through the durable task cleanup owner", async () => {
  await withFixture(async (test) => {
    const seeded = await seedPendingScout(test);

    const dry = await test.reconcile(false);
    expect(entries(dry.cleaned, "scout-task")[0]?.id).toBe("scout-1");
    expect(test.pool.leases.has(seeded.lease.leaseId)).toBe(true);

    const applied = await test.reconcile(true);
    expect(entries(applied.cleaned, "scout-task")[0]?.id).toBe("scout-1");
    expect(test.pool.returnedPaths).toContain(seeded.lease.path);
    expect(test.pool.panes.has(seeded.endpoint.paneId)).toBe(false);

    const again = await test.reconcile(true);
    expect(entries(again.cleaned, "scout-task")).toHaveLength(0);
  });
});

test("cancelled implementation cleanup requires explicit discard approval", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test);

    const dry = await test.reconcile(false);
    expect(entries(dry.cleaned, "implementation-task")[0]?.id).toBe("implementation-1");
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);

    const applied = await test.reconcile(true, true);
    expect(entries(applied.cleaned, "implementation-task")[0]?.id).toBe("implementation-1");
    expect(test.pool.leases.has(lease.leaseId)).toBe(false);
    expect(test.pool.returnedPaths).toContain(lease.path);
    const returned = test.pool.calls.find(
      (call) =>
        call.argv[0] === "treehouse" &&
        call.argv.includes("return") &&
        call.argv.includes(lease.leaseId),
    );
    expect(returned?.argv).toContain("--force");
  });
});

test("blocked implementation cleanup is included only in explicit discard reconciliation", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test, "blocked");

    const safe = await test.reconcile(false);
    expect(entries(safe.cleaned, "implementation-task")).toHaveLength(0);
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);

    const applied = await test.reconcile(true, true);
    expect(entries(applied.cleaned, "implementation-task")[0]?.id).toBe("implementation-1");
    expect(test.pool.leases.has(lease.leaseId)).toBe(false);
    expect(test.pool.returnedPaths).toContain(lease.path);
  });
});

test("a worktree whose commits are in another task is freed only with its own approval", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test, "cancelled", {
      dirty: false,
      otherBranch: "tandem/other",
    });
    scriptHistory(test, true);

    const dry = await test.reconcile(false);
    expect(entries(dry.cleaned, "implementation-task")).toHaveLength(0);
    expect(dry.freeable).toEqual([
      expect.objectContaining({ id: "implementation-1", containedIn: "task e2c0fbb5" }),
    ]);

    const cleanedOnly = await test.reconcile(true);
    expect(cleanedOnly.freeable.map((entry) => entry.id)).toEqual(["implementation-1"]);
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);
    expect(returnOf(test, lease)).toBeUndefined();

    const freed = await test.reconcile(true, false, true);
    const entry = entries(freed.cleaned, "implementation-task")[0];
    expect(entry).toMatchObject({ id: "implementation-1", containedIn: "task e2c0fbb5" });
    expect(entry?.reason).toContain(`branch ${lease.branch} is kept`);
    expect(freed.freeable).toEqual([]);
    expect(test.pool.leases.has(lease.leaseId)).toBe(false);
    expect(returnOf(test, lease)?.argv).toContain("--force");
    expect(branchChanges(test)).toEqual([]);
  });
});

test("a worktree with a commit found nowhere else is never offered or freed", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test, "cancelled", {
      dirty: false,
      otherBranch: "tandem/other",
    });
    scriptHistory(test, false);

    const dry = await test.reconcile(false);
    expect(dry.freeable).toEqual([]);
    expect(entries(dry.cleaned, "implementation-task")[0]?.worktreeStays).toBe(
      "has 1 commit not in main or any other work",
    );

    await test.reconcile(true, false, true);
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);
    expect(returnOf(test, lease)).toBeUndefined();
  });
});

test("a dirty worktree is never offered or freed, even when its commits are elsewhere", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test, "cancelled", {
      dirty: true,
      otherBranch: "tandem/other",
    });
    scriptHistory(test, true);

    const dry = await test.reconcile(false);
    expect(dry.freeable).toEqual([]);
    expect(entries(dry.cleaned, "implementation-task")[0]?.worktreeStays).toBe(
      "has uncommitted changes",
    );

    await test.reconcile(true, false, true);
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);
    expect(returnOf(test, lease)).toBeUndefined();
  });
});

test("tandem fix --yes alone never frees; --free-superseded with --yes does", async () => {
  await withFixture(async (test) => {
    const lease = await seedPendingImplementation(test, "cancelled", {
      dirty: false,
      otherBranch: "tandem/other",
    });
    scriptHistory(test, true);
    const fix = async (...flags: string[]) => {
      const output: string[] = [];
      const result = await runTerminal(["fix", "--home", test.home, ...flags], {
        cwd: test.root,
        processEnvironment: {},
        isTTY: false,
        run: test.pool.run,
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      });
      return { result, output: output.join("") };
    };

    const refused = await fix("--free-superseded");
    expect(refused.result.exitCode).not.toBe(0);
    expect(refused.output).toContain("Rerun with --yes --free-superseded");

    const yes = await fix("--yes", "--json");
    const report = JSON.parse(yes.output) as ReconcileReport;
    expect(report.mode).toBe("applied");
    expect(report.freeable.map((entry) => entry.id)).toEqual(["implementation-1"]);
    expect(test.pool.leases.has(lease.leaseId)).toBe(true);

    const freed = await fix("--yes", "--free-superseded");
    expect(freed.output).toContain("freed · work is in task e2c0fbb5");
    expect(test.pool.leases.has(lease.leaseId)).toBe(false);
  });
});

test("an unreadable coordinator record is reported and left exactly where it is", async () => {
  await withFixture(async (test) => {
    const directory = registrySessionDirectory(test.home, "tandem-elsewhere");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${digest(test.repo)}.json`);
    await writeFile(path, "{ not json", { encoding: "utf8", mode: 0o600 });

    const applied = await test.reconcile(true);
    const reported = entries(applied.quarantined, "unreadable-record");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.path).toBe(path);
    expect(reported[0]?.reason).toContain("could not be read");
    expect(await Bun.file(path).text()).toBe("{ not json");
  });
});

test("a dry run issues only read-only commands", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    await seedOrphanedLease(test);
    await seedPendingScout(test);
    test.pool.stopCoordinator();
    const before = test.pool.calls.length;

    await test.reconcile(false);

    const issued = test.pool.calls.slice(before);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.filter(mutating)).toEqual([]);
    expect(test.pool.returnedPaths).toHaveLength(0);
    expect(test.pool.panes.size).toBe(2);
    expect(test.pool.coordinatorLeases()).toHaveLength(3);
  });
});

test("the machine-readable report keeps a stable versioned shape", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    test.pool.stopCoordinator();

    const report = await test.reconcile(false);
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "mode",
      "home",
      "cleaned",
      "retained",
      "quarantined",
      "failed",
      "freeable",
    ]);
    expect(report.schemaVersion).toBe(3);
    expect(report.home).toBe(test.home);
    const coordinator = entries(report.cleaned, "coordinator")[0];
    if (coordinator === undefined) throw new Error("the stopped coordinator was not reported");
    expect(Object.keys(coordinator)).toEqual([
      "kind",
      "id",
      "reason",
      "repoPath",
      "sessionId",
      "path",
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

test("the scan reads every session under the home, not just one", async () => {
  await withFixture(async (test) => {
    await test.launch(FIRST_SESSION);
    test.pool.stopCoordinator();
    await test.reconcile(true);
    await test.launch(SECOND_SESSION);

    const observation = await scanTandemResources({
      run: test.pool.run,
      terminal: terminalBackend(test.pool.run, { terminal: "herdr" }),
      home: test.home,
      poolRoot: test.poolRoot,
      repoPaths: [test.repo],
      clock: () => TIMESTAMP,
    });
    expect(observation.coordinators.map((observed) => observed.found.sessionId)).toEqual([
      SECOND_SESSION,
    ]);
    expect(observation.coordinators[0]?.liveness.status).toBe("live");
  });
});
