import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/contracts.ts";
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

const SESSION_ID = "resources-session";
const FIRST_HEAD = "1111111111111111111111111111111111111111";
const SECOND_HEAD = "2222222222222222222222222222222222222222";
const THIRD_HEAD = "3333333333333333333333333333333333333333";
const TASK_LEASE_ID = "lease-task-keep";
const TASK_LEASE_HOLDER = "task:keep-me";

type StartupFailure = "bound-source" | "workspace-create" | "pane-run" | "ownership";

type FakeWorktree = {
  head: string;
  branch: string;
  dirty: boolean;
  unmerged: boolean;
};

type FakeLease = {
  leaseId: string;
  leaseHolder: string;
  path: string;
};

type FakePane = {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  /** The foreground OMP argv, or undefined for a pane that has returned to its shell. */
  omp: readonly string[] | undefined;
};

type Pool = Readonly<{
  readonly run: CommandRunner;
  readonly calls: readonly CommandRequest[];
  readonly leases: Map<string, FakeLease>;
  readonly worktrees: Map<string, FakeWorktree>;
  readonly panes: Map<string, FakePane>;
  readonly workspaces: Map<string, string>;
  readonly returnedPaths: readonly string[];
  setFailure: (failure: StartupFailure | undefined) => void;
  setRepoHead: (head: string) => void;
  stopCoordinator: () => void;
  coordinatorLeases: () => readonly FakeLease[];
}>;

type PoolInput = Readonly<{
  readonly repo: string;
  readonly poolRoot: string;
  readonly taskWorktreePath: string;
}>;

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function nativeError(code: string): CommandResult {
  return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
}

function shellTokens(command: string): readonly string[] {
  return [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? "");
}

/** Recovers the OMP argv a pane would really run, from the bootstrap script Tandem wrote for it. */
async function bootstrappedCommand(paneRunCommand: string): Promise<readonly string[]> {
  const scriptPath = shellTokens(paneRunCommand)[1];
  if (scriptPath === undefined) throw new Error("pane run command named no bootstrap script");
  const tokens = shellTokens(await readFile(scriptPath, "utf8"));
  const start = tokens.indexOf("omp");
  if (start === -1) throw new Error("coordinator bootstrap script never invokes omp");
  return tokens.slice(start);
}

function fakePool(input: PoolInput): Pool {
  const calls: CommandRequest[] = [];
  const leases = new Map<string, FakeLease>();
  const worktrees = new Map<string, FakeWorktree>();
  const panes = new Map<string, FakePane>();
  const workspaces = new Map<string, string>();
  const poolPaths: string[] = [input.taskWorktreePath];
  const returnedPaths: string[] = [];
  let repoHead = FIRST_HEAD;
  let failure: StartupFailure | undefined;
  let identities = 0;

  leases.set(TASK_LEASE_ID, {
    leaseId: TASK_LEASE_ID,
    leaseHolder: TASK_LEASE_HOLDER,
    path: input.taskWorktreePath,
  });
  worktrees.set(input.taskWorktreePath, {
    head: "9999999999999999999999999999999999999999",
    branch: "tandem/task-keep-me",
    dirty: true,
    unmerged: false,
  });

  const worktreeState = (path: string): FakeWorktree => {
    const existing = worktrees.get(path);
    if (existing !== undefined) return existing;
    const created = { head: repoHead, branch: "", dirty: false, unmerged: false };
    worktrees.set(path, created);
    return created;
  };

  const gitCommand = (argv: readonly string[], cwd: string): CommandResult => {
    const path = argv[1] === "-C" ? resolve(argv[2] ?? cwd) : resolve(cwd);
    const rest = argv.slice(argv[1] === "-C" ? 3 : 1);
    if (path === resolve(input.repo)) worktreeState(path).head = repoHead;
    const state = worktreeState(path);
    if (rest[0] === "remote") return ok("\n");
    if (rest[0] === "rev-parse") {
      if (rest.includes("--show-toplevel")) return ok(`${path}\n`);
      if (rest.includes("--git-common-dir")) return ok(`${resolve(input.repo)}/.git\n`);
      return ok(`${state.head}\n`);
    }
    if (rest[0] === "branch") return ok(`${state.branch}\n`);
    if (rest[0] === "status") return ok(state.dirty ? " M coordinator-note.txt\n" : "");
    if (rest[0] === "diff") {
      return rest.includes("--diff-filter=U") && state.unmerged ? ok("conflict.txt\n") : ok("");
    }
    if (rest[0] === "cat-file") return ok("");
    if (rest[0] === "merge-base") return ok("");
    if (rest[0] === "switch") {
      state.branch = rest[3] ?? "";
      state.head = rest[4] ?? state.head;
      return ok("");
    }
    throw new Error(`unexpected git command ${argv.join(" ")}`);
  };

  const treehouseCommand = async (argv: readonly string[]): Promise<CommandResult> => {
    const action = argv[3];
    if (action === "status") {
      return ok(
        JSON.stringify(
          [...leases.values()].map((lease) => ({
            name: lease.leaseId,
            path: lease.path,
            status: "leased",
            flavor: "worktree",
            lease_id: lease.leaseId,
            lease_holder: lease.leaseHolder,
            leased_at: "2030-01-02T03:04:05.000Z",
            processes: [],
          })),
        ),
      );
    }
    if (action === "get") {
      const holder = argv[argv.indexOf("--lease-holder") + 1] ?? "";
      const held = new Set([...leases.values()].map((lease) => lease.path));
      const free = poolPaths.find((path) => !held.has(path));
      identities += 1;
      const path = free ?? join(input.poolRoot, `worktree-${poolPaths.length + 1}`);
      if (free === undefined) {
        poolPaths.push(path);
        await mkdir(path, { recursive: true });
      }
      const leaseId = `lease-${identities}`;
      leases.set(leaseId, { leaseId, leaseHolder: holder, path });
      worktreeState(path).head = repoHead;
      return ok(
        JSON.stringify({
          path,
          lease_id: leaseId,
          lease_holder: holder,
          leased_at: "2030-01-02T03:04:05.000Z",
        }),
      );
    }
    if (action === "return") {
      const path = resolve(argv[4] ?? "");
      const leaseId = argv[argv.indexOf("--if-lease-id") + 1] ?? "";
      const holder = argv[argv.indexOf("--if-lease-holder") + 1] ?? "";
      const lease = leases.get(leaseId);
      if (lease === undefined || lease.leaseHolder !== holder || lease.path !== path) {
        return { code: 1, stdout: "", stderr: "lease identity does not match\n" };
      }
      leases.delete(leaseId);
      returnedPaths.push(path);
      const state = worktreeState(path);
      state.branch = "";
      return ok("");
    }
    throw new Error(`unexpected treehouse command ${argv.join(" ")}`);
  };

  const closePane = (paneId: string): void => {
    const pane = panes.get(paneId);
    if (pane === undefined) return;
    panes.delete(paneId);
    const remaining = [...panes.values()].some(
      (candidate) => candidate.workspaceId === pane.workspaceId,
    );
    if (!remaining) workspaces.delete(pane.workspaceId);
  };

  const herdrCommand = async (argv: readonly string[]): Promise<CommandResult> => {
    const resource = argv[3];
    const action = argv[4];
    if (resource === "status") {
      return ok(
        JSON.stringify({
          server: { socket: "/tmp/fake-herdr.sock", running: true, session: argv[2] },
        }),
      );
    }
    if (resource === "api" && action === "snapshot") {
      return ok(
        JSON.stringify({
          result: {
            type: "session_snapshot",
            snapshot: {
              panes: [...panes.values()].map((pane) => ({
                workspace_id: pane.workspaceId,
                tab_id: pane.tabId,
                pane_id: pane.paneId,
                agent_status: pane.omp === undefined ? "idle" : "working",
              })),
            },
          },
        }),
      );
    }
    if (resource === "workspace") {
      if (action === "create") {
        if (failure === "workspace-create") {
          return { code: 1, stdout: "", stderr: "workspace create refused\n" };
        }
        identities += 1;
        const workspaceId = `workspace-${identities}`;
        const paneId = `pane-${identities}`;
        const tabId = `tab-${identities}`;
        workspaces.set(workspaceId, argv[argv.indexOf("--label") + 1] ?? "");
        panes.set(paneId, {
          paneId,
          tabId,
          workspaceId,
          cwd: resolve(argv[argv.indexOf("--cwd") + 1] ?? ""),
          omp: undefined,
        });
        return ok(
          JSON.stringify({
            result: {
              workspace: { workspace_id: workspaceId },
              tab: { tab_id: tabId },
              root_pane: { pane_id: paneId },
            },
          }),
        );
      }
      const workspaceId = argv[5] ?? "";
      if (!workspaces.has(workspaceId)) return nativeError("workspace_not_found");
      if (action === "rename") workspaces.set(workspaceId, argv[6] ?? "");
      return ok(
        JSON.stringify({
          result: {
            type: "workspace_info",
            workspace: { workspace_id: workspaceId, label: workspaces.get(workspaceId) },
          },
        }),
      );
    }
    if (resource !== "pane") throw new Error(`unexpected herdr command ${argv.join(" ")}`);
    const paneId = (action === "process-info" ? argv[6] : argv[5]) ?? "";
    const pane = panes.get(paneId);
    if (pane === undefined) return nativeError("pane_not_found");
    if (action === "get") {
      return ok(
        JSON.stringify({
          result: {
            pane: {
              pane_id: pane.paneId,
              tab_id: pane.tabId,
              workspace_id: pane.workspaceId,
              foreground_cwd: pane.cwd,
            },
          },
        }),
      );
    }
    if (action === "process-info") {
      const shell = { pid: 500, name: "zsh", argv: ["-zsh"], argv0: "-zsh" };
      return ok(
        JSON.stringify({
          result: {
            process_info: {
              pane_id: pane.paneId,
              shell_pid: 500,
              foreground_processes:
                pane.omp === undefined
                  ? [shell]
                  : [{ pid: 700, name: "omp", argv: pane.omp, argv0: "omp" }],
            },
          },
        }),
      );
    }
    if (action === "run") {
      if (failure === "pane-run") return { code: 1, stdout: "", stderr: "pane run refused\n" };
      pane.omp =
        failure === "ownership" ? ["omp", "--unrelated"] : await bootstrappedCommand(argv[6] ?? "");
      return ok(JSON.stringify({ result: { type: "ok" } }));
    }
    if (action === "close") {
      closePane(paneId);
      return ok(JSON.stringify({ result: { type: "ok" } }));
    }
    throw new Error(`unexpected herdr pane command ${argv.join(" ")}`);
  };

  const run: CommandRunner = async (request) => {
    calls.push(request);
    const program = request.argv[0];
    if (program === "git") return gitCommand(request.argv, request.cwd);
    if (program === "treehouse") return treehouseCommand(request.argv);
    if (program === "herdr") return herdrCommand(request.argv);
    throw new Error(`unexpected command ${request.argv.join(" ")}`);
  };

  return {
    run,
    calls,
    leases,
    worktrees,
    panes,
    workspaces,
    returnedPaths,
    setFailure: (next) => {
      failure = next;
    },
    setRepoHead: (head) => {
      repoHead = head;
    },
    stopCoordinator: () => {
      for (const pane of panes.values()) pane.omp = undefined;
    },
    coordinatorLeases: () =>
      [...leases.values()].filter((lease) => lease.leaseId !== TASK_LEASE_ID),
  };
}

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
