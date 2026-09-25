import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_MODEL, type JevFetch } from "../../src/adapters/typesafe.ts";
import type {
  Clock,
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  IdFactory,
  IsoTimestamp,
  PullRequestMetadata,
  ResearchContinuation,
  ResolvedPolicy,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { COORDINATOR_QUARANTINE_DIRECTORY } from "../../src/coordinator/resources.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type {
  DurableJob,
  DurableOperation,
  DurableReservation,
  RuntimeState,
  RuntimeTaskState,
} from "../../src/runtime/schema.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore, type TaskStore } from "../../src/tasks/store.ts";

export const SCENARIO_NOW: IsoTimestamp = "2030-01-01T00:00:00.000Z";
export const SCENARIO_HEAD = "0123456789abcdef0123456789abcdef01234567";
export const SCENARIO_NEXT_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
export const SCENARIO_SESSION = "scenario-session";
export const SCENARIO_TASK_ID = "task-1";

export const SCENARIO_POLICY: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "scenario/coordinator", thinking: "low" },
      scout: { model: "scenario/scout", thinking: "low" },
      implementer: { model: "scenario/implementer", thinking: "low" },
      reviewer: { model: "scenario/reviewer", thinking: "low" },
      presentation: { model: "scenario/presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

/** Every external boundary a scenario is allowed to touch. */
export type ScenarioBoundary = "herdr" | "treehouse" | "git" | "omp" | "ps" | "typesafe" | "github";

/** One CI check on a scripted pull request or branch. */
export type ScenarioCheck = Readonly<{
  readonly name: string;
  readonly state: "pass" | "fail" | "pending";
  /** Branch protection requires it; with none required, every check counts. */
  readonly required?: boolean;
  readonly startedAt?: IsoTimestamp;
}>;

/**
 * A scripted pull request. Scenarios change its fields directly between checks, the way GitHub
 * would change while the watcher waits.
 */
export type ScenarioPullRequest = {
  readonly repo: string;
  readonly number: number;
  title: string;
  branch: string;
  base: string;
  /** The base branch's commit; a new one gives a conflict a new fix attempt. */
  baseHead: string;
  head: string;
  draft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: string;
  labels: string[];
  autoMerge: boolean;
  checks: ScenarioCheck[];
  mergedAt?: IsoTimestamp;
  /** Label and auto-merge events in order, as `issues/N/events` lists them. */
  events: ScenarioIssueEvent[];
  /** Files both this pull request and its base changed, which the compare API reports. */
  conflictFiles: string[];
};

export type ScenarioIssueEvent = Readonly<{
  readonly event: "labeled" | "unlabeled" | "auto_merge_disabled";
  readonly label?: string;
  readonly login: string;
  readonly type: "User" | "Bot";
}>;

/** Scripted GitHub: pull requests, branch checks, commits and their trees, and your open PRs. */
export type ScenarioGitHub = Readonly<{
  readonly openPullRequest: (
    input: Partial<ScenarioPullRequest> & Pick<ScenarioPullRequest, "repo" | "number">,
  ) => ScenarioPullRequest;
  /** Checks on the tip of a branch, such as the base a pull request merges into. */
  readonly setBranchChecks: (repo: string, branch: string, checks: ScenarioCheck[]) => void;
  /** Someone pushes to the pull request: a new head, with a new tree unless `sameTree`. */
  readonly push: (pullRequest: ScenarioPullRequest, options?: { sameTree?: boolean }) => string;
  /** The pull requests `gh search prs --author @me` finds (opened with `openPullRequest`). */
  readonly myPullRequests: Array<Readonly<{ repo: string; number: number }>>;
  /** Repositories whose default branch has `.aviator/config.yml`. */
  readonly aviatorRepositories: string[];
  /** Repositories with GitHub's "Allow auto-merge" on. */
  readonly autoMergeRepositories: string[];
  /** Repositories the gh login can't read, as with missing SSO authorization. */
  readonly unreadableRepositories: string[];
  /** The rules on each `repo:branch`, as `repos/R/rules/branches/B` lists them. */
  readonly branchRules: Map<string, unknown[]>;
  /** Someone else changes labels, like a merge queue kicking the pull request out. */
  readonly relabel: (
    pullRequest: ScenarioPullRequest,
    change: Readonly<{ add?: string; remove?: string; by: string; bot: boolean }>,
  ) => void;
}>;

/** Scripted TypeSafe provider behavior; no scenario ever reaches the real endpoint. */
export type ScenarioProviderBehavior =
  | Readonly<{ readonly kind: "answers"; readonly answers: Readonly<Record<string, unknown>> }>
  | Readonly<{ readonly kind: "timeout" }>
  | Readonly<{ readonly kind: "unavailable"; readonly status?: number }>
  | Readonly<{ readonly kind: "malformed"; readonly body?: string }>;

export type ScenarioEvent = Readonly<{
  readonly boundary: ScenarioBoundary;
  readonly action: string;
  readonly outcome: "ok" | "refused";
}>;

/** Scripted refusal for one boundary action; `times` defaults to a single occurrence. */
export type ScenarioFailure = Readonly<{
  readonly boundary: ScenarioBoundary;
  readonly action: string;
  readonly times?: number;
  readonly code?: number;
  readonly stderr?: string;
}>;

/**
 * Every resource a scenario can observe, grouped by the outcome its owner proved.
 * Entries are stable identifiers such as `pane:pane-1`, `lease:lease-1`, `job:job-1`.
 */
export type ResourceLedger = Readonly<{
  readonly retained: readonly string[];
  readonly released: readonly string[];
  readonly failed: readonly string[];
  readonly quarantined: readonly string[];
}>;

export type ScenarioSnapshot = Readonly<{
  readonly tasks: readonly TaskRecord[];
  readonly runtime: RuntimeState;
  readonly resources: ResourceLedger;
  readonly trace: readonly ScenarioEvent[];
}>;

type PaneState = {
  present: boolean;
  workspaceId: string;
  tabId: string;
  foregroundCwd: string;
  shellPid: number;
  processes: readonly Readonly<{ pid: number; name: string; argv: readonly string[] }>[];
};

type LeaseState = {
  readonly name: string;
  readonly path: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly leasedAt: IsoTimestamp;
  returned: boolean;
};

type CheckoutState = {
  head: string;
  branch: string;
  dirty: boolean;
  unmerged: boolean;
  toplevel: string;
  commonDir: string;
};

export type ScenarioCheckoutPatch = Readonly<Partial<Omit<CheckoutState, "toplevel">>>;

export type ScenarioWorld = Readonly<{
  readonly home: string;
  readonly repoPath: string;
  readonly poolRoot: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly failAt: (failure: ScenarioFailure) => void;
  readonly openPane: (
    input: Readonly<{ readonly paneId: string; readonly cwd: string }>,
  ) => Endpoint;
  readonly paneIsPresent: (paneId: string) => boolean;
  /** Replaces a pane's foreground, as when its agent exits and someone starts another by hand. */
  readonly replaceForeground: (paneId: string, argv: readonly string[]) => void;
  readonly grantLease: (
    input: Readonly<{ readonly name: string; readonly holder: string }>,
  ) => Promise<WorktreeLease>;
  readonly patchCheckout: (path: string, patch: ScenarioCheckoutPatch) => void;
  readonly providerFetch: (behavior: ScenarioProviderBehavior) => JevFetch;
  readonly github: ScenarioGitHub;
  /** Moves the scenario clock forward; it starts at SCENARIO_NOW and never moves on its own. */
  readonly advanceClock: (minutes: number) => void;
  readonly trace: () => readonly ScenarioEvent[];
  readonly snapshot: () => Promise<ScenarioSnapshot>;
  readonly close: () => Promise<void>;
}>;

function commandResult(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function missingPane(): CommandResult {
  return commandResult("", 1, JSON.stringify({ error: { code: "pane_not_found" } }));
}

function positionalArguments(argv: readonly string[]): readonly string[] {
  return argv.filter((entry) => !entry.startsWith("--"));
}

function describeCommand(argv: readonly string[]): Readonly<{
  readonly boundary: ScenarioBoundary;
  readonly action: string;
}> {
  const program = argv[0];
  if (program === "herdr") {
    const words = positionalArguments(argv.slice(3)).slice(0, 2);
    return { boundary: "herdr", action: `herdr ${words.join(" ")}`.trim() };
  }
  if (program === "treehouse") {
    const verb = positionalArguments(argv.slice(3))[0] ?? "";
    return { boundary: "treehouse", action: `treehouse ${verb}`.trim() };
  }
  if (program === "git") {
    const rest = argv.slice(3);
    const verb = rest[0] ?? "";
    const qualifier = verb === "rev-parse" ? ` ${rest.at(-1) ?? ""}` : "";
    return { boundary: "git", action: `git ${verb}${qualifier}` };
  }
  if (program === "omp") return { boundary: "omp", action: `omp ${argv[1] ?? ""}`.trim() };
  if (program === "ps") return { boundary: "ps", action: "ps" };
  if (program === "gh") return { boundary: "github", action: githubAction(argv) };
  throw new Error(`unexpected scenario command ${JSON.stringify(argv)}`);
}

/** Flags of `gh api` that take a value, so the endpoint is the first word that is neither. */
const GH_API_VALUE_FLAGS = new Set(["-X", "-f", "-F", "--jq", "-H"]);

function githubEndpoint(argv: readonly string[]): string {
  for (let index = 2; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (GH_API_VALUE_FLAGS.has(word)) index += 1;
    else if (!word.startsWith("-")) return word;
  }
  return "";
}

function githubField(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length - 1; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1] ?? "";
    if ((flag === "-f" || flag === "-F") && value.startsWith(`${name}=`)) {
      return value.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Names a `gh` call by what it does, like `gh pr view` or `gh api PATCH git/refs`. */
function githubAction(argv: readonly string[]): string {
  if (argv[1] !== "api") return `gh ${argv[1] ?? ""} ${argv[2] ?? ""}`.trim();
  const method = argv[argv.indexOf("-X") + 1] ?? "GET";
  const endpoint = githubEndpoint(argv);
  const kinds: readonly (readonly [RegExp, string])[] = [
    [/^graphql$/u, "graphql"],
    [/\/git\/commits$/u, "git/commits"],
    [/\/git\/refs\//u, "git/refs"],
    [/\/commits\/[^/]+$/u, "commits"],
    [/\/issues\/\d+\/events/u, "issues/events"],
    [/\/pulls\/\d+\/update-branch$/u, "pulls/update-branch"],
    [/\/contents\//u, "contents"],
    [/\/compare\//u, "compare"],
    [/\/merges$/u, "merges"],
    [/\/rules\/branches\//u, "rules"],
    [/\/protection$/u, "protection"],
    [/^repos\/[^/]+\/[^/]+$/u, "repository"],
  ];
  const kind = kinds.find(([pattern]) => pattern.test(endpoint))?.[1] ?? endpoint;
  return `gh api ${argv.includes("-X") ? method : "GET"} ${kind}`;
}

function scenarioCheckRun(check: ScenarioCheck): Readonly<Record<string, unknown>> {
  return {
    __typename: "CheckRun",
    name: check.name,
    status: check.state === "pending" ? "IN_PROGRESS" : "COMPLETED",
    conclusion: check.state === "pass" ? "SUCCESS" : check.state === "fail" ? "FAILURE" : "",
    detailsUrl: `https://ci.example/${check.name}`,
    ...(check.startedAt === undefined ? {} : { startedAt: check.startedAt }),
  };
}

/** Recovers the process a bootstrap script would exec, so a launched pane proves the real argv. */
function parseQuotedCommand(value: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === " ") {
      index += 1;
      continue;
    }
    if (value[index] !== "'") throw new Error(`unquoted scenario command ${JSON.stringify(value)}`);
    index += 1;
    let token = "";
    while (index < value.length) {
      if (value[index] === "'") {
        if (value.slice(index, index + 5) === `'"'"'`) {
          token += "'";
          index += 5;
          continue;
        }
        index += 1;
        break;
      }
      token += value[index];
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * The foreground program each long-running launcher leaves in the pane: agents keep it, and glow's
 * pager stays open until `q`. An ordinary command such as `cat` exits back to the shell.
 */
const PERSISTENT_LAUNCHERS: Readonly<Record<string, string>> = {
  bun: "omp",
  node: "omp",
  omp: "omp",
  sh: "omp",
  glow: "less",
};

function persistentForeground(argv: readonly string[]): string | undefined {
  // `sh -c 'exec "$1" …' sh PROGRAM …` runs PROGRAM, as the brief viewer does.
  const program = argv[1] === "-c" ? argv[4] : argv[0];
  const launcher = (program ?? "").split("/").at(-1) ?? "";
  return PERSISTENT_LAUNCHERS[launcher];
}

async function bootstrapProcessArgv(command: string): Promise<readonly string[]> {
  const tokens = parseQuotedCommand(command);
  const scriptPath = tokens[1];
  if (tokens[0] !== "/bin/sh" || scriptPath === undefined) return tokens;
  const script = await readFile(scriptPath, "utf8");
  // The first command after the INT trap is the coordinator launch itself.
  const lines = script.split("\n");
  const executed = lines[lines.indexOf("trap : INT") + 1];
  if (executed === undefined) return tokens;
  const argv = parseQuotedCommand(executed);
  const start = argv.findIndex((entry, position) => position > 0 && !entry.includes("="));
  return start === -1 ? argv : argv.slice(start);
}

export type ScenarioWorldOptions = Readonly<{
  readonly sessionId?: string;
  /** What `git remote get-url origin` prints in every checkout; empty when unset. */
  readonly origin?: string;
  readonly ompModels?: readonly unknown[];
}>;

export async function createScenarioWorld(
  options: ScenarioWorldOptions = {},
): Promise<ScenarioWorld> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-scenario-")));
  const home = join(root, "home");
  const repoPath = join(root, "repo");
  const poolRoot = join(root, "pool");
  await mkdir(home, { recursive: true });
  await mkdir(join(repoPath, ".git"), { recursive: true });
  await mkdir(poolRoot, { recursive: true });
  const sessionId = options.sessionId ?? SCENARIO_SESSION;

  const trace: ScenarioEvent[] = [];
  const failures: { failure: ScenarioFailure; remaining: number }[] = [];
  const panes = new Map<string, PaneState>();
  const workspaceLabels = new Map<string, string>();
  const leases = new Map<string, LeaseState>();
  const checkouts = new Map<string, CheckoutState>();
  let nextPaneNumber = 0;
  let nextLeaseNumber = 0;
  let nextPid = 900;
  let identifier = 0;

  const checkoutFor = (path: string): CheckoutState => {
    const existing = checkouts.get(path);
    if (existing !== undefined) return existing;
    const created: CheckoutState = {
      head: SCENARIO_HEAD,
      branch: "",
      dirty: false,
      unmerged: false,
      toplevel: path,
      commonDir: join(repoPath, ".git"),
    };
    checkouts.set(path, created);
    return created;
  };
  checkoutFor(repoPath).branch = "main";

  const openPane = (
    input: Readonly<{ readonly paneId: string; readonly cwd: string }>,
  ): Endpoint => {
    nextPaneNumber += 1;
    nextPid += 1;
    const workspaceId = `workspace-${nextPaneNumber}`;
    const tabId = `tab-${nextPaneNumber}`;
    panes.set(input.paneId, {
      present: true,
      workspaceId,
      tabId,
      foregroundCwd: input.cwd,
      shellPid: nextPid,
      processes: [{ pid: nextPid, name: "sh", argv: ["sh"] }],
    });
    workspaceLabels.set(workspaceId, `scenario ${input.paneId}`);
    return { sessionId, workspaceId, tabId, paneId: input.paneId, role: "scout", generation: 0 };
  };

  const grantLease = async (
    input: Readonly<{ readonly name: string; readonly holder: string }>,
  ): Promise<WorktreeLease> => {
    nextLeaseNumber += 1;
    const path = join(poolRoot, `worktree-${nextLeaseNumber}`);
    const leaseId = `lease-${nextLeaseNumber}`;
    await mkdir(path, { recursive: true });
    leases.set(leaseId, {
      name: input.name,
      path,
      leaseId,
      leaseHolder: input.holder,
      leasedAt: SCENARIO_NOW,
      returned: false,
    });
    checkoutFor(path).branch = `tandem/${input.name}`;
    return {
      root: poolRoot,
      path,
      name: input.name,
      baseHead: SCENARIO_HEAD,
      branch: `tandem/${input.name}`,
      leaseId,
      leaseHolder: input.holder,
      leasedAt: SCENARIO_NOW,
    };
  };

  const herdr = async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    const words = positionalArguments(argv.slice(3));
    const [resource, action] = words;
    if (resource === "status") {
      return commandResult(
        JSON.stringify({ server: { socket: join(root, "herdr.sock"), running: true } }),
      );
    }
    if (resource === "api" && action === "snapshot") {
      return commandResult(
        JSON.stringify({
          result: {
            type: "session_snapshot",
            snapshot: {
              panes: [...panes.entries()]
                .filter(([, pane]) => pane.present)
                .map(([paneId, pane]) => ({
                  workspace_id: pane.workspaceId,
                  tab_id: pane.tabId,
                  pane_id: paneId,
                })),
            },
          },
        }),
      );
    }
    if (resource === "workspace") {
      if (action === "create") {
        nextPaneNumber += 1;
        const paneId = `pane-${nextPaneNumber}`;
        const cwdIndex = argv.indexOf("--cwd");
        const labelIndex = argv.indexOf("--label");
        const endpoint = openPane({
          paneId,
          cwd: argv[cwdIndex + 1] ?? request.cwd,
        });
        workspaceLabels.set(endpoint.workspaceId, argv[labelIndex + 1] ?? "");
        return commandResult(
          JSON.stringify({
            result: {
              workspace: { workspace_id: endpoint.workspaceId },
              tab: { tab_id: endpoint.tabId },
              root_pane: { pane_id: paneId },
            },
          }),
        );
      }
      const workspaceId = words[2] ?? "";
      if (!workspaceLabels.has(workspaceId)) {
        return commandResult("", 1, JSON.stringify({ error: { code: "workspace_not_found" } }));
      }
      if (action === "rename") workspaceLabels.set(workspaceId, words[3] ?? "");
      return commandResult(
        JSON.stringify({
          result: {
            type: "workspace_info",
            workspace: { workspace_id: workspaceId, label: workspaceLabels.get(workspaceId) },
          },
        }),
      );
    }
    if (resource !== "pane") throw new Error(`unexpected herdr command ${JSON.stringify(argv)}`);
    const paneId = words[2] ?? "";
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.present) return missingPane();
    if (action === "get") {
      return commandResult(
        JSON.stringify({
          result: {
            pane: {
              pane_id: paneId,
              tab_id: pane.tabId,
              workspace_id: pane.workspaceId,
              foreground_cwd: pane.foregroundCwd,
            },
          },
        }),
      );
    }
    if (action === "process-info") {
      return commandResult(
        JSON.stringify({
          result: {
            process_info: {
              pane_id: paneId,
              shell_pid: pane.shellPid,
              foreground_processes: pane.processes.map((process) => ({
                pid: process.pid,
                name: process.name,
                argv: process.argv,
              })),
            },
          },
        }),
      );
    }
    if (action === "run") {
      const launched = await bootstrapProcessArgv(argv.at(-1) ?? "");
      const foreground = persistentForeground(launched);
      if (foreground !== undefined) {
        nextPid += 1;
        pane.processes = [{ pid: nextPid, name: foreground, argv: launched }];
      } else {
        pane.processes = [{ pid: pane.shellPid, name: "sh", argv: ["sh"] }];
      }
      return commandResult(JSON.stringify({ result: { type: "ok" } }));
    }
    if (action === "send-keys") {
      pane.processes = [{ pid: pane.shellPid, name: "sh", argv: ["sh"] }];
      return commandResult(JSON.stringify({ result: { type: "ok" } }));
    }
    if (action === "close") {
      pane.present = false;
      return commandResult(JSON.stringify({ result: { type: "ok" } }));
    }
    if (action === "split") {
      nextPaneNumber += 1;
      const splitId = `pane-${nextPaneNumber}`;
      const cwdIndex = argv.indexOf("--cwd");
      nextPid += 1;
      panes.set(splitId, {
        present: true,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        foregroundCwd: argv[cwdIndex + 1] ?? pane.foregroundCwd,
        shellPid: nextPid,
        processes: [{ pid: nextPid, name: "sh", argv: ["sh"] }],
      });
      return commandResult(
        JSON.stringify({
          result: {
            pane: { pane_id: splitId, tab_id: pane.tabId, workspace_id: pane.workspaceId },
          },
        }),
      );
    }
    throw new Error(`unexpected herdr command ${JSON.stringify(argv)}`);
  };

  const treehouse = async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    const words = positionalArguments(argv.slice(3));
    const verb = words[0];
    if (verb === "status") {
      return commandResult(
        JSON.stringify(
          [...leases.values()]
            .filter((lease) => !lease.returned)
            .map((lease) => ({
              name: lease.name,
              path: lease.path,
              status: "leased",
              flavor: "worktree",
              lease_id: lease.leaseId,
              lease_holder: lease.leaseHolder,
              leased_at: lease.leasedAt,
              processes: [],
            })),
        ),
      );
    }
    if (verb === "get") {
      const holderIndex = argv.indexOf("--lease-holder");
      const lease = await grantLease({
        name: `pool-${nextLeaseNumber + 1}`,
        holder: argv[holderIndex + 1] ?? "unknown",
      });
      checkoutFor(lease.path).branch = "";
      return commandResult(
        JSON.stringify({
          path: lease.path,
          lease_id: lease.leaseId,
          lease_holder: lease.leaseHolder,
          leased_at: lease.leasedAt,
        }),
      );
    }
    if (verb === "return") {
      const leaseIdIndex = argv.indexOf("--if-lease-id");
      const lease = leases.get(argv[leaseIdIndex + 1] ?? "");
      if (lease === undefined) return commandResult("", 1, "unknown lease");
      lease.returned = true;
      return commandResult();
    }
    throw new Error(`unexpected treehouse command ${JSON.stringify(argv)}`);
  };

  const git = async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    const target = argv[2] ?? request.cwd;
    const rest = argv.slice(3);
    const checkout = checkoutFor(target);
    const verb = rest[0];
    if (verb === "remote") return commandResult(options.origin ?? "");
    if (verb === "fetch") return commandResult();
    if (verb === "cat-file") return commandResult();
    if (verb === "rev-parse") {
      const reference = rest.at(-1);
      if (reference === "HEAD") return commandResult(checkout.head);
      if (reference === "--show-toplevel") return commandResult(checkout.toplevel);
      if (reference === "--git-common-dir") return commandResult(checkout.commonDir);
      return commandResult(reference ?? checkout.head);
    }
    if (verb === "branch") return commandResult(checkout.branch);
    if (verb === "status") return commandResult(checkout.dirty ? " M scenario.txt\n" : "");
    if (verb === "diff") {
      return commandResult(
        rest.includes("--diff-filter=U") && checkout.unmerged ? "conflict.txt\n" : "",
      );
    }
    if (verb === "switch") {
      checkout.branch = rest[3] ?? checkout.branch;
      checkout.head = rest[4] ?? checkout.head;
      return commandResult();
    }
    if (verb === "merge-base") {
      return commandResult("", rest[2] === rest[3] ? 0 : 1);
    }
    throw new Error(`unexpected git command ${JSON.stringify(argv)}`);
  };

  const pullRequests: ScenarioPullRequest[] = [];
  const branchChecks = new Map<string, ScenarioCheck[]>();
  const trees = new Map<string, string>();
  const myPullRequests: Array<Readonly<{ repo: string; number: number }>> = [];
  const aviatorRepositories: string[] = [];
  const autoMergeRepositories: string[] = [];
  const unreadableRepositories: string[] = [];
  const branchRules = new Map<string, unknown[]>();
  const relabel: ScenarioGitHub["relabel"] = (pullRequest, change) => {
    const type = change.bot ? "Bot" : "User";
    if (change.remove !== undefined) {
      pullRequest.labels = pullRequest.labels.filter((label) => label !== change.remove);
      pullRequest.events.push({ event: "unlabeled", label: change.remove, login: change.by, type });
    }
    if (change.add !== undefined && !pullRequest.labels.includes(change.add)) {
      pullRequest.labels.push(change.add);
      pullRequest.events.push({ event: "labeled", label: change.add, login: change.by, type });
    }
  };
  let nextCommit = 0;
  const newCommit = (tree: string): string => {
    nextCommit += 1;
    const sha = `commit-${nextCommit}`;
    trees.set(sha, tree);
    return sha;
  };
  const findPullRequest = (repo: string, number: number): ScenarioPullRequest => {
    const found = pullRequests.find(
      (candidate) => candidate.repo === repo && candidate.number === number,
    );
    if (found === undefined) throw new Error(`no scripted pull request ${repo}#${number}`);
    return found;
  };
  const github: ScenarioGitHub = {
    openPullRequest: (input) => {
      const created: ScenarioPullRequest = {
        title: `Pull request ${input.number}`,
        branch: `feature-${input.number}`,
        base: "main",
        baseHead: "base-1",
        head: newCommit(`tree-${input.number}`),
        draft: false,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        labels: [],
        autoMerge: false,
        checks: [],
        events: [],
        conflictFiles: [],
        ...input,
      };
      if (!trees.has(created.head)) trees.set(created.head, `tree-${input.number}`);
      pullRequests.push(created);
      return created;
    },
    setBranchChecks: (repo, branch, checks) => {
      branchChecks.set(`${repo}:${branch}`, checks);
    },
    push: (pullRequest, options = {}) => {
      const tree =
        options.sameTree === true ? (trees.get(pullRequest.head) ?? "") : `tree-${nextCommit + 1}`;
      pullRequest.head = newCommit(tree);
      return pullRequest.head;
    },
    myPullRequests,
    aviatorRepositories,
    autoMergeRepositories,
    unreadableRepositories,
    branchRules,
    relabel,
  };
  const pullRequestArgument = (argv: readonly string[]): ScenarioPullRequest =>
    findPullRequest(argv[argv.indexOf("--repo") + 1] ?? "", Number(argv[3]));
  const restartChecks = (pr: ScenarioPullRequest): void => {
    pr.checks = pr.checks.map((check) => ({
      name: check.name,
      state: "pending",
      ...(check.required === undefined ? {} : { required: check.required }),
    }));
  };

  const gh = async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    if (argv[1] === "pr" && argv[2] === "view") {
      const pr = findPullRequest(argv[argv.indexOf("--repo") + 1] ?? "", Number(argv[3]));
      const [owner, name] = pr.repo.split("/");
      return commandResult(
        JSON.stringify({
          state: pr.state,
          isDraft: pr.draft,
          title: pr.title,
          url: `https://github.com/${pr.repo}/pull/${pr.number}`,
          headRefName: pr.branch,
          headRefOid: pr.head,
          headRepository: { name },
          headRepositoryOwner: { login: owner },
          isCrossRepository: false,
          baseRefName: pr.base,
          baseRefOid: pr.baseHead,
          mergeable: pr.mergeable,
          mergeStateStatus: pr.mergeStateStatus,
          reviewDecision: pr.reviewDecision,
          reviewRequests: [],
          labels: pr.labels.map((label) => ({ name: label })),
          autoMergeRequest: pr.autoMerge ? { enabledAt: SCENARIO_NOW } : null,
          mergedAt: pr.mergedAt ?? null,
          statusCheckRollup: pr.checks.map(scenarioCheckRun),
        }),
      );
    }
    if (argv[1] === "pr" && argv[2] === "edit") {
      const pr = pullRequestArgument(argv);
      const option = (name: string) =>
        argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
      const add = option("--add-label");
      const remove = option("--remove-label");
      relabel(pr, {
        ...(add === undefined ? {} : { add }),
        ...(remove === undefined ? {} : { remove }),
        by: "you",
        bot: false,
      });
      return commandResult(`https://github.com/${pr.repo}/pull/${pr.number}`);
    }
    if (argv[1] === "pr" && argv[2] === "merge" && argv.includes("--auto")) {
      pullRequestArgument(argv).autoMerge = true;
      return commandResult();
    }
    if (argv[1] === "repo" && argv[2] === "view") {
      return commandResult(
        JSON.stringify({
          squashMergeAllowed: true,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
        }),
      );
    }
    if (argv[1] === "search" && argv[2] === "prs") {
      return commandResult(
        JSON.stringify(
          myPullRequests.map((ref) => {
            const pr = findPullRequest(ref.repo, ref.number);
            return {
              number: ref.number,
              repository: { nameWithOwner: ref.repo },
              title: pr.title,
              url: `https://github.com/${ref.repo}/pull/${ref.number}`,
              isDraft: pr.draft,
            };
          }),
        ),
      );
    }
    if (argv[1] !== "api") throw new Error(`unexpected gh command ${JSON.stringify(argv)}`);
    const endpoint = githubEndpoint(argv);
    if (endpoint === "graphql" && githubField(argv, "number") !== undefined) {
      const pr = findPullRequest(
        `${githubField(argv, "owner")}/${githubField(argv, "name")}`,
        Number(githubField(argv, "number")),
      );
      return commandResult(
        pr.checks
          .filter((check) => check.required === true)
          .map((check) => `${check.name}\n`)
          .join(""),
      );
    }
    if (endpoint === "graphql") {
      const repo = `${githubField(argv, "owner")}/${githubField(argv, "name")}`;
      const branch = (githubField(argv, "ref") ?? "").replace(/^refs\/heads\//u, "");
      const checks = branchChecks.get(`${repo}:${branch}`) ?? [];
      return commandResult(
        JSON.stringify({
          data: {
            repository: {
              ref: {
                target: {
                  statusCheckRollup: { contexts: { nodes: checks.map(scenarioCheckRun) } },
                },
              },
            },
          },
        }),
      );
    }
    const repository = /^repos\/([^/]+\/[^/]+)$/u.exec(endpoint)?.[1];
    if (repository !== undefined) {
      if (unreadableRepositories.includes(repository)) {
        return commandResult(
          "",
          1,
          "gh: Resource protected by organization SAML enforcement (HTTP 403)",
        );
      }
      return commandResult(
        JSON.stringify({
          allow_auto_merge: autoMergeRepositories.includes(repository),
          default_branch: "main",
        }),
      );
    }
    const rules = /^repos\/([^/]+\/[^/]+)\/rules\/branches\/(.+)$/u.exec(endpoint);
    if (rules !== null) {
      return commandResult(JSON.stringify(branchRules.get(`${rules[1]}:${rules[2]}`) ?? []));
    }
    if (/^repos\/[^/]+\/[^/]+\/branches\/.+\/protection$/u.test(endpoint)) {
      return commandResult("", 1, "gh: Branch not protected (HTTP 404)");
    }
    const contents = /^repos\/([^/]+\/[^/]+)\/contents\//u.exec(endpoint);
    if (contents !== null) {
      return aviatorRepositories.includes(contents[1] ?? "")
        ? commandResult(".aviator/config.yml")
        : commandResult("", 1, "gh: Not Found (HTTP 404)");
    }
    const events = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events/u.exec(endpoint);
    if (events !== null) {
      const pr = findPullRequest(events[1] ?? "", Number(events[2]));
      return commandResult(pr.events.map((event) => JSON.stringify(event)).join("\n"));
    }
    const compare = /^repos\/([^/]+\/[^/]+)\/compare\/(.+)\.\.\.(.+)$/u.exec(endpoint);
    if (compare !== null) {
      const pr = pullRequests.find(
        (candidate) =>
          candidate.repo === compare[1] && [compare[2], compare[3]].includes(candidate.head),
      );
      return commandResult(JSON.stringify(pr?.conflictFiles ?? []));
    }
    const merges = /^repos\/([^/]+\/[^/]+)\/merges$/u.exec(endpoint);
    if (merges !== null) {
      const pr = pullRequests.find(
        (candidate) =>
          candidate.repo === merges[1] && candidate.branch === githubField(argv, "base"),
      );
      if (pr === undefined) return commandResult("", 1, "gh: Not Found (HTTP 404)");
      pr.head = newCommit(`tree-${nextCommit + 1}`);
      pr.mergeStateStatus = "CLEAN";
      restartChecks(pr);
      return commandResult(pr.head);
    }
    const commit = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/u.exec(endpoint)?.[1];
    if (commit !== undefined) return commandResult(trees.get(commit) ?? "");
    if (/\/git\/commits$/u.test(endpoint)) {
      const parent = githubField(argv, "parents[]") ?? "";
      const sha = newCommit(githubField(argv, "tree") ?? "");
      trees.set(`${sha}:parent`, parent);
      return commandResult(sha);
    }
    const ref = /^repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/u.exec(endpoint);
    if (ref !== null) {
      const sha = githubField(argv, "sha") ?? "";
      const pr = pullRequests.find(
        (candidate) => candidate.repo === ref[1] && candidate.branch === ref[2],
      );
      if (pr === undefined || trees.get(`${sha}:parent`) !== pr.head) {
        return commandResult("", 1, "gh: Update is not a fast forward (HTTP 422)");
      }
      pr.head = sha;
      restartChecks(pr);
      return commandResult(JSON.stringify({ object: { sha } }));
    }
    throw new Error(`unexpected gh command ${JSON.stringify(argv)}`);
  };

  const dispatch = async (request: CommandRequest): Promise<CommandResult> => {
    const program = request.argv[0];
    if (program === "gh") return gh(request);
    if (program === "herdr") return herdr(request);
    if (program === "treehouse") return treehouse(request);
    if (program === "git") return git(request);
    if (program === "omp") {
      return commandResult(JSON.stringify({ models: options.ompModels ?? [] }));
    }
    if (program === "ps") {
      const lines = [...panes.values()]
        .filter((pane) => pane.present)
        .flatMap((pane) =>
          pane.processes.map((process) => `${process.pid} ${process.argv.join(" ")}`),
        );
      return commandResult(lines.join("\n"));
    }
    throw new Error(`unexpected scenario command ${JSON.stringify(request.argv)}`);
  };

  const takeFailure = (boundary: ScenarioBoundary, action: string): CommandResult | undefined => {
    const entry = failures.find(
      (candidate) =>
        candidate.remaining > 0 &&
        candidate.failure.boundary === boundary &&
        candidate.failure.action === action,
    );
    if (entry === undefined) return undefined;
    entry.remaining -= 1;
    return commandResult(
      "",
      entry.failure.code ?? 1,
      entry.failure.stderr ?? `scenario refused ${action}`,
    );
  };

  const run: CommandRunner = async (request) => {
    const { boundary, action } = describeCommand(request.argv);
    const injected = takeFailure(boundary, action);
    const result = injected ?? (await dispatch(request));
    trace.push({ boundary, action, outcome: result.code === 0 ? "ok" : "refused" });
    return result;
  };

  let now = Date.parse(SCENARIO_NOW);
  const clock: Clock = () => new Date(now).toISOString();
  const idFactory: IdFactory = () => {
    identifier += 1;
    return `scenario-id-${identifier}`;
  };
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });

  const snapshot = async (): Promise<ScenarioSnapshot> => {
    const runtime = await readRuntimeState(runtimeFile(home));
    const tasks = await store.list();
    return {
      tasks,
      runtime,
      resources: await classifyResources({ home, panes, leases, runtime, tasks }),
      trace: [...trace],
    };
  };

  return {
    home,
    repoPath,
    poolRoot,
    sessionId,
    run,
    clock,
    idFactory,
    store,
    failAt: (failure) => {
      failures.push({ failure, remaining: failure.times ?? 1 });
    },
    openPane,
    paneIsPresent: (paneId) => panes.get(paneId)?.present === true,
    replaceForeground: (paneId, argv) => {
      const pane = panes.get(paneId);
      if (pane === undefined) throw new Error(`unknown scenario pane ${paneId}`);
      nextPid += 1;
      pane.processes = [{ pid: nextPid, name: argv[0] ?? "", argv }];
    },
    grantLease,
    patchCheckout: (path, patch) => {
      Object.assign(checkoutFor(path), patch);
    },
    providerFetch: (behavior) => async (_endpoint, init) => {
      if (behavior.kind === "timeout") {
        trace.push({ boundary: "typesafe", action: "typesafe evaluate", outcome: "refused" });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      const refused = behavior.kind !== "answers";
      trace.push({
        boundary: "typesafe",
        action: "typesafe evaluate",
        outcome: refused ? "refused" : "ok",
      });
      if (behavior.kind === "unavailable") {
        return new Response("", { status: behavior.status ?? 503 });
      }
      if (behavior.kind === "malformed") {
        return new Response(behavior.body ?? "{not json", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          model: JEV_MODEL,
          answers: behavior.answers,
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
        { status: 200 },
      );
    },
    github,
    advanceClock: (minutes) => {
      now += minutes * 60_000;
    },
    trace: () => [...trace],
    snapshot,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads the durable notes a refused coordinator launch leaves under the Tandem home. */
async function coordinatorQuarantineIds(home: string): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(join(home, COORDINATOR_QUARANTINE_DIRECTORY));
  } catch {
    return [];
  }
  const identifiers: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    identifiers.push(`coordinator-quarantine:${entry.slice(0, -".json".length)}`);
  }
  return identifiers;
}

async function classifyResources(
  input: Readonly<{
    readonly home: string;
    readonly panes: ReadonlyMap<string, PaneState>;
    readonly leases: ReadonlyMap<string, LeaseState>;
    readonly runtime: RuntimeState;
    readonly tasks: readonly TaskRecord[];
  }>,
): Promise<ResourceLedger> {
  const retained: string[] = [];
  const released: string[] = [];
  const failed: string[] = [];
  const quarantined: string[] = [];
  for (const [paneId, pane] of input.panes) {
    (pane.present ? retained : released).push(`pane:${paneId}`);
  }
  for (const lease of input.leases.values()) {
    (lease.returned ? released : retained).push(`lease:${lease.leaseId}`);
  }
  for (const task of input.runtime.tasks) {
    if (task.worktree !== undefined) retained.push(`worktree:${task.worktree.leaseId}`);
    for (const endpoint of task.endpoints) retained.push(`endpoint:${endpoint.paneId}`);
    if (task.reservation !== undefined) {
      const identifier = `reservation:${task.reservation.id}`;
      (task.reservation.phase === "released" ? released : retained).push(identifier);
    }
    for (const job of task.jobs) {
      const identifier = `job:${job.id}`;
      if (job.phase === "failed") failed.push(identifier);
      else if (job.phase === "consumed") released.push(identifier);
      else retained.push(identifier);
    }
    if (task.operation?.phase === "quarantined") quarantined.push(`operation:${task.operation.id}`);
    if (task.operation?.phase === "failed") failed.push(`operation:${task.operation.id}`);
    if (task.legacyQuarantine !== undefined) {
      quarantined.push(`reservation:${task.legacyQuarantine.reservationId}`);
    }
  }
  for (const task of input.tasks) {
    if (task.stage === "blocked") quarantined.push(`task:${task.id}`);
    if (task.reportPath !== undefined && (await fileExists(task.reportPath))) {
      retained.push(`report:${task.id}`);
    }
    const cleanup = task.cleanup;
    if (cleanup === undefined) continue;
    const identifier = `cleanup:${task.id}`;
    if (cleanup.status === "released") released.push(identifier);
    else if (cleanup.status === "quarantined") quarantined.push(identifier);
    else retained.push(identifier);
  }
  quarantined.push(...(await coordinatorQuarantineIds(input.home)));
  return { retained, released, failed, quarantined };
}

export type SeedTaskInput = Readonly<{
  readonly kind: TaskRecord["kind"];
  readonly requestId?: string;
  readonly policy?: ResolvedPolicy;
  readonly stage?: TaskRecord["stage"];
  readonly previousStage?: TaskRecord["stage"];
  readonly reviewHead?: string;
  readonly reviewRound?: number;
  readonly generation?: number;
  readonly reviews?: TaskRecord["reviews"];
  readonly reportPath?: string;
  readonly worktree?: WorktreeLease;
  readonly endpoints?: readonly Endpoint[];
  readonly researchContinuation?: ResearchContinuation;
  readonly manualVerification?: readonly string[];
  readonly pullRequest?: PullRequestMetadata;
}>;

/** Seeds one durable task in the scenario home, bypassing approval prompts the scenario is not testing. */
export async function seedScenarioTask(
  world: ScenarioWorld,
  input: SeedTaskInput,
): Promise<TaskRecord> {
  let task = await world.store.create({
    id: SCENARIO_TASK_ID,
    repoPath: world.repoPath,
    kind: input.kind,
    objective: "exercise one durable scenario path",
    acceptanceCriteria: ["the durable outcome is observable"],
    ...(input.manualVerification === undefined
      ? {}
      : { manualVerification: input.manualVerification }),
    surfaces: ["scenario"],
    policy: input.policy ?? SCENARIO_POLICY,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.researchContinuation === undefined
      ? {}
      : { researchContinuation: input.researchContinuation }),
  });
  if (
    task.stage === "awaiting-approval" &&
    input.stage !== undefined &&
    input.stage !== "awaiting-approval"
  ) {
    task = await world.store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "approve" },
        { now: world.clock(), notificationId: "scenario-approve" },
      ),
    );
  }
  return world.store.update(task.id, task.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: world.clock(),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.previousStage === undefined ? {} : { previousStage: input.previousStage }),
    ...(input.reviewHead === undefined ? {} : { reviewHead: input.reviewHead }),
    ...(input.reviewRound === undefined ? {} : { reviewRound: input.reviewRound }),
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.reviews === undefined ? {} : { reviews: input.reviews }),
    ...(input.reportPath === undefined ? {} : { reportPath: input.reportPath }),
    ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    ...(input.endpoints === undefined ? {} : { endpoints: input.endpoints }),
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  }));
}

export async function seedScenarioRuntime(
  world: ScenarioWorld,
  task: RuntimeTaskState,
): Promise<void> {
  await writeRuntimeState(runtimeFile(world.home), {
    schemaVersion: 1,
    tasks: [task],
    presentations: [],
  });
}

export function scenarioRuntimeTask(overrides: Partial<RuntimeTaskState> = {}): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: SCENARIO_TASK_ID,
    sourceCheckpoint: {
      head: SCENARIO_HEAD,
      base: SCENARIO_HEAD,
      diff: "",
      dirty: false,
      unmerged: false,
    },
    taskName: "scenario-task",
    endpoints: [],
    jobs: [],
    ...overrides,
  };
}

export function scenarioJob(
  input: Readonly<{
    readonly home: string;
    readonly role: Exclude<DurableJob["role"], "validation">;
    readonly cwd: string;
    readonly endpoint: Endpoint;
    readonly phase?: DurableJob["phase"];
    readonly generation?: number;
  }>,
): DurableJob {
  const generation = input.generation ?? 0;
  const directory = join(input.home, "jobs", SCENARIO_TASK_ID, String(generation), "job-1");
  const phase = input.phase ?? "running";
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: SCENARIO_TASK_ID,
    generation,
    role: input.role,
    kind: "worker",
    cwd: input.cwd,
    jobPath: join(directory, "job.json"),
    resultPath: join(directory, "result.json"),
    attempt: 1,
    phase,
    launchAttempted: phase !== "reserved",
    createdAt: SCENARIO_NOW,
    operationId: "operation-1",
    endpoint: input.endpoint,
  };
}

export function scenarioOperation(
  job: DurableJob,
  overrides: Partial<DurableOperation> = {},
): DurableOperation {
  return {
    schemaVersion: 1,
    id: "operation-1",
    taskId: job.taskId,
    kind: job.role === "scout" ? "scout" : "implementation",
    role: job.role,
    generation: job.generation,
    inputHead: SCENARIO_HEAD,
    policyDigest: "scenario-policy",
    instructionRevision: 0,
    jobId: job.id,
    phase: "running",
    fencingRevision: 1,
    claimOwner: "scenario-controller",
    createdAt: SCENARIO_NOW,
    effects: [],
    ...overrides,
  };
}

export function scenarioReservation(
  overrides: Partial<DurableReservation> = {},
): DurableReservation {
  return {
    schemaVersion: 1,
    id: "reservation-1",
    taskId: SCENARIO_TASK_ID,
    ownerSessionId: SCENARIO_SESSION,
    operationId: "operation-1",
    phase: "endpoint",
    createdAt: SCENARIO_NOW,
    ...overrides,
  };
}

export async function withScenario(
  options: ScenarioWorldOptions,
  body: (world: ScenarioWorld) => Promise<void>,
): Promise<void> {
  const world = await createScenarioWorld(options);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}
