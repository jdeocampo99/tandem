import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../../../src/config/policy.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
} from "../../../src/contracts.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  launchCoordinator,
} from "../../../src/coordinator/launch.ts";
import { closeCoordinatorPanel, openPanelBeside } from "../../../src/coordinator/panel.ts";
import { type CoordinatorRecord, recordPath } from "../../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { resetCoordinators } from "../../../src/coordinator/reset.ts";
import { restartCoordinator } from "../../../src/coordinator/restart.ts";
import {
  findRestoredCoordinatorPanes,
  retireCoordinatorWorkspace,
} from "../../../src/coordinator/workspace.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { checkTools } from "../../../src/onboarding/tools.ts";
import { runtimeFile, writeRuntimeState } from "../../../src/runtime/persistence.ts";
import { recoverEndpointFromLaunch } from "../../../src/tasks/endpoint-launch.ts";
import { createTaskStore } from "../../../src/tasks/store.ts";
import { herdrBackend } from "../../../src/terminal-backend/herdr/backend.ts";
import { openReviewerEndpoint } from "../../../src/workers/terminal-control.ts";
import { FIRST_HEAD, fakePool } from "../../coordinator/fake-pool.ts";

/** Wraps a fake runner so the pin sees every command the case sends to it. */
export type Recorder = (run: CommandRunner) => CommandRunner;

export type PinCase = Readonly<{
  name: string;
  /** Drives one terminal operation against a fake Herdr; resolves with what the caller observes. */
  exercise: (record: Recorder) => Promise<unknown>;
}>;

export type OutcomeCase = Readonly<{
  name: string;
  /** Drives one failure path against a fake Herdr; resolves with what the caller observes. */
  exercise: () => Promise<unknown>;
}>;

const SESSION = "pin";
const CWD = "/work/repo";
const SOCKET = "/tmp/herdr-pin.sock";

const ENDPOINT: Endpoint = {
  terminal: "herdr" as const,
  sessionId: SESSION,
  workspaceId: "w1",
  tabId: "t1",
  paneId: "p1",
  role: "implementer",
  generation: 2,
};

function ok(payload: unknown = { result: { type: "ok" } }): CommandResult {
  return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

function failed(code: string): CommandResult {
  return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: code } }) };
}

function paneGet(paneId: string, workspaceId: string, tabId: string, cwd = CWD): CommandResult {
  return ok({
    result: {
      pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, foreground_cwd: cwd },
    },
  });
}

const SHELL = { pid: 41, name: "zsh", argv: ["-zsh"], argv0: "-zsh" };
const WORKER = {
  pid: 42,
  name: "omp",
  argv: ["omp", "--mode", "worker"],
  argv0: "omp",
  cmdline: "omp --mode worker",
};

function processInfo(paneId: string, processes: readonly unknown[]): CommandResult {
  return ok({
    result: {
      process_info: {
        pane_id: paneId,
        shell_pid: 41,
        foreground_process_group_id: 41,
        foreground_processes: processes,
      },
    },
  });
}

/**
 * A fake Herdr answering from a script keyed by the argv after `herdr --session <s>`. A list
 * answers successive calls in order and repeats its last entry.
 */
function scripted(
  script: Readonly<{ [command: string]: CommandResult | readonly CommandResult[] }>,
): CommandRunner {
  const seen = new Map<string, number>();
  return async (request: CommandRequest) => {
    if (request.argv[0] !== "herdr")
      return { code: 127, stdout: "", stderr: `${request.argv[0]}: not found` };
    const key = request.argv.slice(3).join(" ");
    const entry = script[key];
    if (entry === undefined) return { code: 1, stdout: "", stderr: `unscripted: ${key}` };
    if (!Array.isArray(entry)) return entry as CommandResult;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return entry[Math.min(index, entry.length - 1)] as CommandResult;
  };
}

const IDLE = {
  "pane get p1": paneGet("p1", "w1", "t1"),
  "pane process-info --pane p1": processInfo("p1", [SHELL]),
};
const BUSY = {
  "pane get p1": paneGet("p1", "w1", "t1"),
  "pane process-info --pane p1": processInfo("p1", [WORKER]),
};

async function temporaryRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "tandem-pin-")));
}

async function coordinatorRecord(root: string): Promise<CoordinatorRecord> {
  const repoPath = join(root, "repo");
  const worktree = join(root, "pool", "coordinator-a");
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktree, { recursive: true });
  return {
    schemaVersion: 1,
    repoPath,
    harness: DEFAULT_HARNESS,
    endpoint: {
      terminal: "herdr" as const,
      sessionId: SESSION,
      workspaceId: "cw",
      tabId: "ct",
      paneId: "cp",
      role: "coordinator",
      generation: 0,
    },
    worktree: {
      root: join(root, "pool"),
      path: worktree,
      name: "coordinator-a",
      baseHead: FIRST_HEAD,
      branch: "tandem/coordinator-a",
      leaseId: "lease-a",
      leaseHolder: "coordinator:a",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    command: ["omp", "--coordinator"],
  };
}

export const PIN_CASES: readonly PinCase[] = [
  {
    name: "inspect an idle shell pane",
    exercise: (record) =>
      herdrBackend(record(scripted(IDLE))).inspect({ endpoint: ENDPOINT, cwd: CWD }),
  },
  {
    name: "inspect a pane running a worker",
    exercise: (record) =>
      herdrBackend(record(scripted(BUSY))).inspect({ endpoint: ENDPOINT, cwd: CWD }),
  },
  {
    name: "inspect a missing pane",
    exercise: (record) =>
      herdrBackend(record(scripted({ "pane get p1": failed("pane_not_found") }))).inspect({
        endpoint: ENDPOINT,
        cwd: CWD,
      }),
  },
  {
    name: "inspect a pane that moved to another workspace",
    exercise: (record) =>
      herdrBackend(record(scripted({ "pane get p1": paneGet("p1", "w9", "t1") }))).inspect({
        endpoint: ENDPOINT,
        cwd: CWD,
      }),
  },
  {
    name: "close an idle pane",
    exercise: async (record) => {
      const run = scripted({
        ...IDLE,
        "pane get p1": [paneGet("p1", "w1", "t1"), failed("pane_not_found")],
        "pane close p1": ok(),
      });
      await herdrBackend(record(run)).close({ endpoint: ENDPOINT, cwd: CWD });
      return "closed";
    },
  },
  {
    name: "close a pane that is already gone",
    exercise: async (record) => {
      await herdrBackend(record(scripted({ "pane get p1": failed("pane_not_found") }))).close({
        endpoint: ENDPOINT,
        cwd: CWD,
      });
      return "closed";
    },
  },
  {
    name: "close refuses a busy pane",
    exercise: async (record) => {
      await herdrBackend(record(scripted(BUSY))).close({ endpoint: ENDPOINT, cwd: CWD });
      return "closed";
    },
  },
  {
    name: "close a busy pane the user chose to discard",
    exercise: async (record) => {
      const run = scripted({
        ...BUSY,
        "pane get p1": [paneGet("p1", "w1", "t1"), failed("pane_not_found")],
        "pane close p1": ok(),
      });
      await herdrBackend(record(run)).close({ endpoint: ENDPOINT, cwd: CWD, force: true });
      return "closed";
    },
  },
  {
    name: "close fails when the pane stays open",
    exercise: async (record) => {
      const run = scripted({ ...IDLE, "pane close p1": ok() });
      await herdrBackend(record(run)).close({ endpoint: ENDPOINT, cwd: CWD });
      return "closed";
    },
  },
  {
    name: "interrupt an idle pane sends nothing",
    exercise: async (record) => {
      const result = await herdrBackend(record(scripted(IDLE))).interrupt({
        endpoint: ENDPOINT,
        cwd: CWD,
      });
      return result.wasRunning;
    },
  },
  {
    name: "interrupt a worker and wait for it to stop",
    exercise: async (record) => {
      const run = scripted({
        "pane get p1": paneGet("p1", "w1", "t1"),
        "pane process-info --pane p1": [processInfo("p1", [WORKER]), processInfo("p1", [SHELL])],
        "pane send-keys p1 ctrl+c": ok(),
      });
      const result = await herdrBackend(record(run)).interrupt({
        endpoint: ENDPOINT,
        cwd: CWD,
        pollIntervalMs: 0,
      });
      return result.wasRunning;
    },
  },
  {
    name: "send exit keys",
    exercise: async (record) => {
      await herdrBackend(record(scripted({ "pane send-keys p1 ctrl+d ctrl+d": ok() }))).sendKeys({
        endpoint: ENDPOINT,
        cwd: CWD,
        keys: ["ctrl+d", "ctrl+d"],
      });
      return "sent";
    },
  },
  {
    name: "run a command in a proven pane",
    exercise: async (record) => {
      const run = scripted({
        ...IDLE,
        "pane run p1 'bun' '/work/worker.ts' '/work/job one.json'": ok(),
      });
      const terminal = herdrBackend(record(run));
      await terminal.inspect({ endpoint: ENDPOINT, cwd: CWD });
      await terminal.runCommand({
        endpoint: ENDPOINT,
        cwd: CWD,
        command: ["bun", "/work/worker.ts", "/work/job one.json"],
      });
      return "sent";
    },
  },
  {
    name: "create a task workspace",
    exercise: (record) =>
      herdrBackend(
        record(
          scripted({
            "workspace create --cwd /work/repo --label └ Fix the build --no-focus": ok({
              result: {
                workspace: { workspace_id: "w7" },
                tab: { tab_id: "t7" },
                root_pane: { pane_id: "p7" },
              },
            }),
          }),
        ),
      ).createWorkspace({
        sessionId: SESSION,
        cwd: CWD,
        label: "└ Fix the build",
        role: "implementer",
        generation: 1,
      }),
  },
  {
    name: "create a task workspace nested under its coordinator",
    exercise: async (record) => {
      const moves: unknown[] = [];
      const workspaces = [
        { workspace_id: "cw", label: "◆ repo" },
        { workspace_id: "other", label: "◆ other" },
        { workspace_id: "w7", label: "└ Fix the build" },
      ];
      const created = await herdrBackend(
        record(
          scripted({
            "workspace create --cwd /work/repo --label └ Fix the build --no-focus": ok({
              result: {
                workspace: { workspace_id: "w7" },
                tab: { tab_id: "t7" },
                root_pane: { pane_id: "p7" },
              },
            }),
            "status --json": ok({ server: { socket: SOCKET, running: true } }),
            "workspace list": ok({ result: { workspaces } }),
          }),
        ),
        {
          moveWorkspace: async (request) => {
            moves.push(request);
            return { result: { type: "workspace_list", workspaces } };
          },
        },
      ).createWorkspace({
        sessionId: SESSION,
        cwd: CWD,
        label: "└ Fix the build",
        role: "implementer",
        generation: 1,
        parentWorkspaceId: "cw",
      });
      return { created, moves };
    },
  },
  {
    name: "order a workspace after its parent",
    exercise: async (record) => {
      const moves: unknown[] = [];
      const workspaces = [
        { workspace_id: "cw", label: "◆ repo" },
        { workspace_id: "other" },
        { workspace_id: "w7", label: "└ Fix the build" },
      ];
      const warnings = await herdrBackend(
        record(
          scripted({
            "status --json": ok({ server: { socket: SOCKET, running: true } }),
            "workspace list": ok({ result: { workspaces } }),
          }),
        ),
        {
          moveWorkspace: async (request) => {
            moves.push(request);
            return { result: { type: "workspace_list", workspaces } };
          },
        },
      ).orderWorkspaceAfter({
        sessionId: SESSION,
        cwd: CWD,
        workspaceId: "w7",
        parentWorkspaceId: "cw",
      });
      return { warnings, moves };
    },
  },
  {
    name: "open a reviewer pane beside a stopped writer",
    exercise: async (record) => {
      const run = scripted({
        ...IDLE,
        "pane split p1 --direction right --cwd /work/repo --no-focus": ok({
          result: { pane: { pane_id: "p2", tab_id: "t1", workspace_id: "w1" } },
        }),
      });
      return openReviewerEndpoint(
        herdrBackend(record(run)),
        { sessionId: SESSION, cwd: CWD, writer: ENDPOINT, generation: 3 },
        { realpath: async (path) => path },
      );
    },
  },
  {
    name: "split beside a pane known only by id",
    exercise: async (record) => {
      const run = scripted({
        "pane get cp": paneGet("cp", "cw", "ct"),
        "pane split cp --direction right --cwd /work/repo --no-focus": ok({
          result: { pane: { pane_id: "rp", tab_id: "ct", workspace_id: "cw" } },
        }),
      });
      return herdrBackend(record(run)).splitBeside({
        sessionId: SESSION,
        cwd: CWD,
        anchorPaneId: "cp",
        role: "reviewer",
        generation: 0,
      });
    },
  },
  {
    name: "list workspaces in sidebar order",
    exercise: (record) =>
      herdrBackend(
        record(
          scripted({
            "workspace list": ok({
              result: {
                workspaces: [{ workspace_id: "cw", label: "◆ repo" }, { workspace_id: "w2" }],
              },
            }),
          }),
        ),
      ).listWorkspaces({ sessionId: SESSION, cwd: CWD }),
  },
  {
    name: "read whether the session's server runs",
    exercise: (record) =>
      herdrBackend(
        record(scripted({ "status --json": ok({ server: { socket: SOCKET, running: false } }) })),
      ).sessionRunning({ sessionId: SESSION, cwd: CWD }),
  },
  {
    name: "show a notification",
    exercise: async (record) => {
      await herdrBackend(
        record(
          scripted({
            "notification show 2 need you --body Fix the build: review --sound request": ok(),
          }),
        ),
      ).notify({
        sessionId: SESSION,
        cwd: CWD,
        title: "2 need you",
        body: "Fix the build: review",
      });
      return "shown";
    },
  },
  {
    name: "open the welcome popup",
    exercise: async (record) => {
      await herdrBackend(
        record(
          scripted({
            "plugin pane open --plugin tandem.ui --entrypoint welcome --env TANDEM_WELCOME_PANE=cp":
              ok(),
          }),
        ),
      ).openWelcome({ sessionId: SESSION, cwd: CWD, paneId: "cp" });
      return "opened";
    },
  },
  {
    name: "prompt an agent Herdr recognizes",
    exercise: async (record) => {
      await herdrBackend(record(scripted({ "agent prompt cp Hello": ok() }))).promptAgent({
        sessionId: SESSION,
        cwd: CWD,
        paneId: "cp",
        text: "Hello",
      });
      return "prompted";
    },
  },
  {
    name: "prompt a pane Herdr sees no agent in",
    exercise: async (record) => {
      await herdrBackend(
        record(
          scripted({
            "agent prompt cp Hello": failed("agent_not_found"),
            "pane send-text cp Hello": ok(),
            "pane send-keys cp enter": ok(),
          }),
        ),
      ).promptAgent({ sessionId: SESSION, cwd: CWD, paneId: "cp", text: "Hello" });
      return "prompted";
    },
  },
  {
    name: "read the session snapshot",
    exercise: (record) =>
      herdrBackend(
        record(
          scripted({
            "api snapshot": ok({
              result: {
                type: "session_snapshot",
                snapshot: {
                  panes: [
                    { workspace_id: "cw", tab_id: "ct", pane_id: "cp", agent_status: "idle" },
                    { workspace_id: "w1", tab_id: "t1", pane_id: "p1" },
                  ],
                },
              },
            }),
          }),
        ),
      ).snapshot({ sessionId: SESSION, cwd: CWD }),
  },
  {
    name: "read the snapshot of a session that is not running",
    exercise: (record) =>
      herdrBackend(record(scripted({ "api snapshot": failed("server_not_running") }))).snapshot({
        sessionId: SESSION,
        cwd: CWD,
        allowMissingSession: true,
      }),
  },
  {
    name: "report and release agent status",
    exercise: async (record) => {
      const reporter = herdrBackend(record(scripted({}))).agentStatusReporter({
        cwd: CWD,
        agentLabel: "tandem-coordinator",
        environment: { HERDR_ENV: "1", HERDR_SESSION: SESSION, HERDR_PANE_ID: "cp" },
      });
      await reporter?.report("working", "Fixing the build");
      await reporter?.report("working", "Fixing the build");
      await reporter?.report("blocked");
      await reporter?.release();
      return reporter === undefined ? "absent" : "reported";
    },
  },
  {
    name: "no agent status outside an active pane",
    exercise: async (record) => {
      const reporter = herdrBackend(record(scripted({}))).agentStatusReporter({
        cwd: CWD,
        agentLabel: "tandem-coordinator",
        environment: { HERDR_SESSION: SESSION, HERDR_PANE_ID: "cp" },
      });
      return reporter === undefined ? "absent" : "reported";
    },
  },
  {
    name: "recover a task pane from its launch intent",
    exercise: async (record) => {
      const root = await temporaryRoot();
      const worktree = join(root, "task");
      await mkdir(worktree);
      return recoverEndpointFromLaunch(
        herdrBackend(
          record(
            scripted({
              "workspace list": ok({
                result: {
                  workspaces: [
                    { workspace_id: "w7", label: "└ Fix the build", active_tab_id: "t7" },
                    { workspace_id: "w8", label: "└ Other", active_tab_id: "t8" },
                  ],
                },
              }),
              "pane list --workspace w7": ok({
                result: {
                  panes: [
                    {
                      pane_id: "p7",
                      tab_id: "t7",
                      workspace_id: "w7",
                      cwd: worktree,
                      foreground_cwd: worktree,
                    },
                  ],
                },
              }),
            }),
          ),
        ),
        {
          terminal: "herdr" as const,
          schemaVersion: 1,
          reservationId: "reservation-1",
          sessionId: SESSION,
          taskName: "fix-build",
          workspaceLabel: "└ Fix the build",
          cwd: worktree,
          role: "implementer",
          generation: 1,
          createdAt: "2030-01-02T03:04:05.000Z",
        },
      );
    },
  },
  {
    name: "find coordinator panes Herdr restored",
    exercise: async (record) => {
      const record0 = await coordinatorRecord(await temporaryRoot());
      return findRestoredCoordinatorPanes(
        herdrBackend(
          record(
            scripted({
              "workspace list": ok({
                result: {
                  workspaces: [
                    { workspace_id: "cw", label: "◆ repo" },
                    { workspace_id: "x", label: "notes" },
                  ],
                },
              }),
              "pane list": ok({
                result: {
                  panes: [
                    { pane_id: "cp", tab_id: "ct", workspace_id: "cw", cwd: record0.worktree.path },
                    { pane_id: "xp", tab_id: "xt", workspace_id: "x", cwd: record0.worktree.path },
                    { pane_id: "malformed" },
                  ],
                },
              }),
            }),
          ),
        ),
        { sessionId: SESSION, repoPath: record0.repoPath, worktree: record0.worktree },
      );
    },
  },
  {
    name: "retire a stopped coordinator workspace",
    exercise: async (record) => {
      const coordinator = await coordinatorRecord(await temporaryRoot());
      const home = join(coordinator.worktree.root, "..", "home");
      await mkdir(home, { recursive: true });
      const run = scripted({
        "workspace get cw": ok({
          result: { type: "workspace_info", workspace: { workspace_id: "cw", label: "◆ repo" } },
        }),
        "pane get cp": [
          paneGet("cp", "cw", "ct", coordinator.worktree.path),
          paneGet("cp", "cw", "ct", coordinator.worktree.path),
          failed("pane_not_found"),
        ],
        "pane process-info --pane cp": processInfo("cp", [SHELL]),
        "api snapshot": ok({
          result: {
            type: "session_snapshot",
            snapshot: { panes: [{ workspace_id: "cw", tab_id: "ct", pane_id: "cp" }] },
          },
        }),
        "pane close cp": ok(),
      });
      return retireCoordinatorWorkspace(herdrBackend(record(run)), home, coordinator);
    },
  },
  {
    name: "open the panel beside a coordinator, then close it",
    exercise: async (record) => {
      const coordinator = await coordinatorRecord(await temporaryRoot());
      const home = join(coordinator.worktree.root, "..", "home");
      await mkdir(home, { recursive: true });
      const panelPane = ok({
        result: {
          pane: { pane_id: "pp", tab_id: "ct", workspace_id: "cw", label: "Tandem panel" },
        },
      });
      const terminal = herdrBackend(
        record(
          scripted({
            [`plugin pane open --plugin tandem.ui --entrypoint panel --placement split --target-pane cp --direction right --no-focus --env TANDEM_PANEL_PROJECT=${coordinator.repoPath}`]:
              ok({ result: { plugin_pane: { pane: { pane_id: "pp" } } } }),
            "pane get pp": [panelPane, panelPane, failed("pane_not_found")],
            "plugin pane close pp": ok(),
          }),
        ),
      );
      const opened = await openPanelBeside(terminal, home, coordinator);
      const reopened = await openPanelBeside(terminal, home, coordinator);
      const closed = await closeCoordinatorPanel(terminal, home, coordinator);
      const again = await closeCoordinatorPanel(terminal, home, coordinator);
      return { opened, reopened, closed, again };
    },
  },
  {
    name: "check Herdr for onboarding",
    exercise: (record) => {
      const run = record(
        scripted({
          "": { code: 0, stdout: "herdr 0.9.1\n", stderr: "" },
          "plugin list": ok(),
        }),
      );
      return checkTools(run, herdrBackend(run), { cwd: CWD, sessionId: SESSION });
    },
  },
  {
    name: "launch a headless coordinator in a new workspace",
    exercise: async (record) => {
      const root = await temporaryRoot();
      const repo = join(root, "repo");
      const home = join(root, "home");
      const poolRoot = join(root, "pool");
      const taskWorktree = join(poolRoot, "task-worktree");
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(home, { recursive: true });
      await mkdir(taskWorktree, { recursive: true });
      await writeFile(join(repo, "README.md"), "pin\n");
      const pool = fakePool({ repo, poolRoot, taskWorktreePath: taskWorktree });
      const started: unknown[] = [];
      const run = record(pool.run);
      const launched = await launchCoordinator(
        {
          cwd: repo,
          repo,
          home,
          poolRoot,
          sessionId: SESSION,
          model: defaultPolicy().models.coordinator,
          continueSession: false,
          headless: true,
          noAttach: true,
          sourceHead: FIRST_HEAD,
        },
        {
          run,
          terminal: herdrBackend(run),
          startPersistent: async (request) => {
            started.push(request);
            return undefined;
          },
          runInteractive: async () => {
            throw new Error("headless launches never attach interactively");
          },
          sleep: async () => undefined,
          processEnvironment: {},
          clock: () => "2030-01-02T03:04:05.000Z",
          newId: () => "quarantine-1",
        },
      );
      return {
        started,
        workspaceId: launched.workspaceId,
        tabId: launched.tabId,
        paneId: launched.paneId,
        panelFailure: launched.panelFailure,
      };
    },
  },
];
/** What a caller sees: the value an operation settles to, or only the class of what it throws. */
async function outcome<Value>(operation: Promise<Value>): Promise<unknown> {
  try {
    return { value: await operation };
  } catch (error) {
    return { error: error instanceof Error ? error.name : typeof error };
  }
}

/** Answers the Herdr commands `override` names, and sends everything else on to `run`. */
function answering(
  run: CommandRunner,
  override: (command: string) => CommandResult | undefined,
): CommandRunner {
  return async (request) =>
    (request.argv[0] === "herdr" ? override(request.argv.slice(3).join(" ")) : undefined) ??
    run(request);
}

const PLAIN_PANE_MISSING: CommandResult = { code: 1, stdout: "", stderr: "Error: no such pane\n" };

type CoordinatorWorld = Readonly<{
  home: string;
  repo: string;
  pool: ReturnType<typeof fakePool>;
  request: CoordinatorLaunchRequest;
  dependencies: (
    run: CommandRunner,
    processEnvironment?: Readonly<Record<string, string>>,
  ) => CoordinatorLaunchDependencies;
}>;

async function coordinatorWorld(): Promise<CoordinatorWorld> {
  const root = await temporaryRoot();
  const repo = join(root, "repo");
  const home = join(root, "home");
  const poolRoot = join(root, "pool");
  const taskWorktree = join(poolRoot, "task-worktree");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(taskWorktree, { recursive: true });
  return {
    home,
    repo,
    pool: fakePool({ repo, poolRoot, taskWorktreePath: taskWorktree }),
    request: {
      cwd: repo,
      repo,
      home,
      poolRoot,
      sessionId: SESSION,
      model: defaultPolicy().models.coordinator,
      continueSession: false,
      headless: true,
      noAttach: true,
      sourceHead: FIRST_HEAD,
    },
    dependencies: (run, processEnvironment = {}) => ({
      run,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("headless launches never attach interactively");
      },
      sleep: async () => undefined,
      processEnvironment,
      clock: () => "2030-01-02T03:04:05.000Z",
      newId: () => "quarantine-1",
      terminal: herdrBackend(run),
    }),
  };
}

/** Launches the world's coordinator and returns its pane id. */
async function launchedPane(world: CoordinatorWorld): Promise<string> {
  const launched = await launchCoordinator(world.request, world.dependencies(world.pool.run));
  if (launched.paneId === undefined) throw new Error("launch returned no coordinator pane");
  return launched.paneId;
}

async function recordKept(world: CoordinatorWorld): Promise<boolean> {
  return (await readCoordinatorRecord(recordPath(world.home, SESSION, world.repo))) !== undefined;
}

/** Restarts the world's coordinator with `run`; reports whether a replacement workspace opened. */
async function restartWith(world: CoordinatorWorld, run: CommandRunner): Promise<unknown> {
  const before = world.pool.calls.length;
  const result = await outcome(restartCoordinator(world.request, world.dependencies(run)));
  const replaced = world.pool.calls
    .slice(before)
    .some((call) => call.argv[3] === "workspace" && call.argv[4] === "create");
  return { ...(result as object), replaced };
}

const LAUNCH_INTENT = (cwd: string) => ({
  terminal: "herdr" as const,
  schemaVersion: 1 as const,
  reservationId: "reservation-1",
  sessionId: SESSION,
  taskName: "fix-build",
  workspaceLabel: "└ Fix the build",
  cwd,
  role: "implementer" as const,
  generation: 1,
  createdAt: "2030-01-02T03:04:05.000Z",
});

async function recoveryStatus(
  workspaces: readonly unknown[],
  panes: (worktree: string) => readonly unknown[],
): Promise<unknown> {
  const worktree = join(await temporaryRoot(), "task");
  await mkdir(worktree);
  const run = scripted({
    "workspace list": ok({ result: { workspaces } }),
    "pane list --workspace w7": ok({ result: { panes: panes(worktree) } }),
  });
  const recovered = await recoverEndpointFromLaunch(herdrBackend(run), LAUNCH_INTENT(worktree));
  return { status: recovered.status };
}

function rootPane(worktree: string) {
  return {
    pane_id: "p7",
    tab_id: "t7",
    workspace_id: "w7",
    cwd: worktree,
    foreground_cwd: worktree,
  };
}

const FIX_BUILD_WORKSPACE = { workspace_id: "w7", label: "└ Fix the build", active_tab_id: "t7" };

export const OUTCOME_CASES: readonly OutcomeCase[] = [
  {
    name: "reset fails closed when the coordinator pane vanishes before its close",
    exercise: async () => {
      const world = await coordinatorWorld();
      const paneId = await launchedPane(world);
      world.pool.stopCoordinator();
      const run = answering(world.pool.run, (command) =>
        command === `pane close ${paneId}` ? failed("pane_not_found") : undefined,
      );
      const result = await outcome(
        resetCoordinators(run, herdrBackend(run), {
          home: world.home,
          sessionId: SESSION,
          repoPaths: [world.repo],
        }),
      );
      return { ...(result as object), recordKept: await recordKept(world) };
    },
  },
  {
    name: "reset accepts an older Herdr's plain-text answer that the closed pane is gone",
    exercise: async () => {
      const world = await coordinatorWorld();
      const paneId = await launchedPane(world);
      world.pool.stopCoordinator();
      const run = answering(world.pool.run, (command) =>
        command === `pane get ${paneId}` && !world.pool.panes.has(paneId)
          ? PLAIN_PANE_MISSING
          : undefined,
      );
      const stopped = await outcome(
        resetCoordinators(run, herdrBackend(run), {
          home: world.home,
          sessionId: SESSION,
          repoPaths: [world.repo],
        }).then((records) => records.length),
      );
      return { ...(stopped as object), recordKept: await recordKept(world) };
    },
  },
  {
    name: "restart fails closed when the coordinator pane vanishes before its close",
    exercise: async () => {
      const world = await coordinatorWorld();
      const paneId = await launchedPane(world);
      return restartWith(
        world,
        answering(world.pool.run, (command) =>
          command === `pane close ${paneId}` ? failed("pane_not_found") : undefined,
        ),
      );
    },
  },
  {
    name: "restart refuses a plain-text answer that the closed pane is gone",
    exercise: async () => {
      const world = await coordinatorWorld();
      const paneId = await launchedPane(world);
      return restartWith(
        world,
        answering(world.pool.run, (command) =>
          command === `pane get ${paneId}` && !world.pool.panes.has(paneId)
            ? PLAIN_PANE_MISSING
            : undefined,
        ),
      );
    },
  },
  {
    name: "launch reports a refused workspace create as a plain error",
    exercise: async () => {
      const world = await coordinatorWorld();
      world.pool.setFailure("workspace-create");
      return outcome(launchCoordinator(world.request, world.dependencies(world.pool.run)));
    },
  },
  {
    name: "launch reports a refused pane run as a plain error",
    exercise: async () => {
      const world = await coordinatorWorld();
      world.pool.setFailure("pane-run");
      return outcome(launchCoordinator(world.request, world.dependencies(world.pool.run)));
    },
  },
  {
    name: "launch reports an unreadable session snapshot as a plain error",
    exercise: async () => {
      const world = await coordinatorWorld();
      const run = answering(world.pool.run, (command) =>
        command === "api snapshot"
          ? { code: 1, stdout: "", stderr: "snapshot exploded\n" }
          : undefined,
      );
      return outcome(launchCoordinator(world.request, world.dependencies(run)));
    },
  },
  {
    name: "launch refuses an empty inherited pane variable as a usage error",
    exercise: async () => {
      const world = await coordinatorWorld();
      return outcome(
        launchCoordinator(
          world.request,
          world.dependencies(world.pool.run, {
            HERDR_ENV: "1",
            HERDR_SESSION: "",
            HERDR_WORKSPACE_ID: "w1",
            HERDR_PANE_ID: "p1",
          }),
        ),
      );
    },
  },
  {
    name: "launch recovery waits on a workspace listing with an unlabelled entry",
    exercise: () =>
      recoveryStatus(
        [FIX_BUILD_WORKSPACE, { workspace_id: "w9", active_tab_id: "t9" }],
        (worktree) => [rootPane(worktree)],
      ),
  },
  {
    name: "launch recovery waits on a pane listing with an incomplete entry",
    exercise: () =>
      recoveryStatus([FIX_BUILD_WORKSPACE], (worktree) => [
        rootPane(worktree),
        { pane_id: "p8", tab_id: "t7", workspace_id: "w7" },
      ]),
  },
  {
    name: "force reset stops when a worker pane's session is gone",
    exercise: async () => {
      const world = await coordinatorWorld();
      await launchedPane(world);
      const store = createTaskStore({
        directory: join(world.home, "tasks"),
        clock: () => "2030-01-02T03:04:05.000Z",
        idFactory: () => "force-task",
      });
      const created = await store.create({
        id: "force-task",
        repoPath: world.repo,
        kind: "scout",
        objective: "Keep the force reset proof honest",
        acceptanceCriteria: ["A vanished session stops the force reset"],
        surfaces: ["reset"],
        policy: {
          config: defaultPolicy(),
          guidance: { implementation: [], validation: [], review: [] },
        },
      });
      await store.update(created.id, created.revision, (task) => ({
        ...task,
        stage: "scouting",
        revision: task.revision + 1,
      }));
      const worker: Endpoint = { ...ENDPOINT, paneId: "worker-pane", role: "scout" };
      await writeRuntimeState(runtimeFile(world.home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: created.id,
            sourceCheckpoint: {
              head: FIRST_HEAD,
              base: FIRST_HEAD,
              diff: "",
              dirty: false,
              unmerged: false,
            },
            sourceRepoPath: world.repo,
            taskName: "force-task",
            endpoints: [worker],
            jobs: [],
          },
        ],
        presentations: [],
      });
      const run = answering(world.pool.run, (command) =>
        command === "pane get worker-pane" ? failed("session_not_found") : undefined,
      );
      const result = await outcome(
        resetCoordinators(run, herdrBackend(run), {
          home: world.home,
          sessionId: SESSION,
          repoPaths: [world.repo],
          force: true,
        }).then((records) => records.length),
      );
      return { ...(result as object), stage: (await store.read(created.id))?.stage };
    },
  },
];
