import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/contracts.ts";

export const FIRST_HEAD = "1111111111111111111111111111111111111111";
export const SECOND_HEAD = "2222222222222222222222222222222222222222";
export const THIRD_HEAD = "3333333333333333333333333333333333333333";
export const TASK_LEASE_ID = "lease-task-keep";
export const TASK_LEASE_HOLDER = "task:keep-me";

export type StartupFailure = "bound-source" | "workspace-create" | "pane-run" | "ownership";

export type FakeWorktree = {
  head: string;
  branch: string;
  dirty: boolean;
  unmerged: boolean;
};

export type FakeLease = {
  leaseId: string;
  leaseHolder: string;
  path: string;
  /** Processes Treehouse reports running inside the worktree. */
  processes?: readonly Readonly<{ pid: number; name: string }>[];
};

export type FakePane = {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  /** The foreground OMP argv, or undefined for a pane that has returned to its shell. */
  omp: readonly string[] | undefined;
};

export type Pool = Readonly<{
  readonly run: CommandRunner;
  readonly calls: readonly CommandRequest[];
  readonly leases: Map<string, FakeLease>;
  readonly worktrees: Map<string, FakeWorktree>;
  readonly panes: Map<string, FakePane>;
  readonly workspaces: Map<string, string>;
  readonly returnedPaths: readonly string[];
  setFailure: (failure: StartupFailure | undefined) => void;
  setRepoHead: (head: string) => void;
  /** Answers repository git commands first; `undefined` falls through to the default fake. */
  setGitScript: (script: (args: readonly string[]) => CommandResult | undefined) => void;
  stopCoordinator: () => void;
  coordinatorLeases: () => readonly FakeLease[];
}>;

export type PoolInput = Readonly<{
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
  // The first command after the INT trap is the coordinator launch itself.
  const lines = (await readFile(scriptPath, "utf8")).split("\n");
  const tokens = shellTokens(lines[lines.indexOf("trap : INT") + 1] ?? "");
  const start = tokens.indexOf("omp");
  if (start === -1) throw new Error("coordinator bootstrap script never invokes omp");
  return tokens.slice(start);
}

/**
 * A fake Herdr, Treehouse, and repository world for coordinator tests: one repository, one
 * pool, and whatever panes, workspaces, and leases the code under test creates. Herdr session
 * ids are not partitioned here, so a pane one session created stays visible to another
 * session's inspection, which is what the one-coordinator-per-repository tests observe.
 */
export function fakePool(input: PoolInput): Pool {
  const calls: CommandRequest[] = [];
  const leases = new Map<string, FakeLease>();
  const worktrees = new Map<string, FakeWorktree>();
  const panes = new Map<string, FakePane>();
  const workspaces = new Map<string, string>();
  const poolPaths: string[] = [input.taskWorktreePath];
  const returnedPaths: string[] = [];
  let repoHead = FIRST_HEAD;
  let failure: StartupFailure | undefined;
  let gitScript = (_args: readonly string[]): CommandResult | undefined => undefined;
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
    const scripted = path === resolve(input.repo) ? gitScript(rest) : undefined;
    if (scripted !== undefined) return scripted;
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
            processes: lease.processes ?? [],
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
    if (program === "ps") {
      const lines = [...panes.values()].flatMap((pane) =>
        pane.omp === undefined ? [] : [`700 ${pane.omp.join(" ")}`],
      );
      return ok(lines.join("\n"));
    }
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
    setGitScript: (next) => {
      gitScript = next;
    },
    stopCoordinator: () => {
      for (const pane of panes.values()) pane.omp = undefined;
    },
    coordinatorLeases: () =>
      [...leases.values()].filter((lease) => lease.leaseId !== TASK_LEASE_ID),
  };
}
