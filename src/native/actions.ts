import { runCommand } from "../adapters/commands.ts";
import {
  resolveTandemEnvironment,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import { type CoordinatorRecord, canonicalPath, pathIsWithin } from "../coordinator/record.ts";
import { decideRecordedOwner } from "../coordinator/recorded-owner.ts";
import { discoverCoordinatorRecords } from "../coordinator/registry.ts";
import { isTandemCheckout } from "../coordinator/tandem-checkout.ts";
import { tryShowCatchUp } from "../memory/native-visits.ts";
import { remainingOnboardingSteps } from "../onboarding/checklist.ts";
import { parseSetupAnswer } from "../onboarding/setup-answer.ts";
import { SETUP_MODES, type SetupMode, type SetupSection } from "../onboarding/setup-view.ts";
import { setupSavedMessage } from "../onboarding/setup-workflow.ts";
import { parseReviewSubmission } from "../pr-review/page.ts";
import { readNativeThreads } from "../pr-watch/native-cache.ts";
import {
  assertFeedbackSize,
  type BriefFeedback,
  briefApprovedPrompt,
  briefFeedbackPrompt,
  type ViewedBrief,
} from "../requests/feedback.ts";
import { briefOriginAfterAction } from "../requests/native-pane.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "../service/controller.ts";
import { prFixToolRequest } from "../session/tools.ts";
import { fixRequestStalled, prFixRequest, taskForPrNumber } from "../tasks/pull-request.ts";
import {
  DEFAULT_COORDINATOR_SESSION,
  environmentSource,
  serviceOptions,
} from "../terminal/cli-application.ts";
import { terminalBackend } from "../terminal-backend/compose.ts";
import type {
  OpenViewResult,
  PaneListing,
  ProvableView,
  TerminalBackend,
  TerminalView,
} from "../terminal-backend/contract.ts";
import { type BlockContext, parseBlockContext } from "./block.ts";
import {
  type Action,
  ActionEnvelope,
  type ActionOrigin,
  type NoticeCode,
  type Outcome,
  PR_GUIDE_PLUGIN,
  PluginEnvelope,
  type PluginOrigin,
  type ViewRef,
} from "./envelope.ts";
import {
  markNativeAlertsRead,
  nativeAlertCounts,
  type Published,
  publishViews,
  readPublished,
  recordVisit,
  viewIndexPath,
} from "./store.ts";

/** Review submissions are the largest envelopes; brief feedback alone is capped at 64,000 bytes. */
const MAX_ENVELOPE_BYTES = 1024 * 1024;

export type NativeActDependencies = Readonly<{
  cwd?: string;
  processEnvironment?: TandemEnvironmentSource;
  run?: CommandRunner;
  terminal?: TerminalBackend;
  service?: TandemService;
  createService?: (options: TandemServiceOptions) => TandemService;
}>;

type Origin = Readonly<{ paneId: string; cwd: string; windowId?: string }>;

type PluginAction = Extract<Action, { verb: "pr-fix" }>;
type PaneAction = Exclude<Action, PluginAction>;

/** One proven click: the project its exact pane belongs to, and the services that act on it. */
type Act = Readonly<{
  environment: TandemBoundaryEnvironment;
  origin: Origin;
  /** The context a block origin echoed; a window command has none. It proves nothing alone. */
  block?: BlockContext;
  /** The one recorded coordinator whose session lists the origin pane; no process is proved. */
  record: CoordinatorRecord;
  run: CommandRunner;
  terminal: TerminalBackend;
  service: () => TandemService;
}>;

/** One recorded project and the services that act on it, with no pane to prove. */
type Project = Omit<Act, "origin" | "block">;

type Handler<V extends PaneAction["verb"]> = (
  act: Act,
  action: Extract<Action, { verb: V }>,
) => Promise<Outcome>;

const DONE: Outcome = { status: "done" };

function notice(status: Outcome["status"], code: NoticeCode, text: string): Outcome {
  return { status, notice: { code, text } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads one envelope, refusing more than the bound instead of buffering it. */
export async function readEnvelope(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_ENVELOPE_BYTES)
      throw new Error(`A native action may not exceed ${MAX_ENVELOPE_BYTES} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A plugin's envelope names itself in `origin.plugin`; every other envelope names a pane. */
function parseEnvelope(text: string): ActionEnvelope | PluginEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("A native action must be one JSON envelope");
  }
  const origin =
    typeof raw === "object" && raw !== null && "origin" in raw ? raw.origin : undefined;
  const named = typeof origin === "object" && origin !== null && "plugin" in origin;
  const parsed = named ? PluginEnvelope.safeParse(raw) : ActionEnvelope.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "envelope"}: ${issue.message}`)
      .join("; "),
  );
}

/**
 * `tandem native act`: one envelope in, one outcome out. Every failure is an outcome the plugin
 * can show; nothing here retries.
 */
export async function nativeAct(text: string, dependencies: NativeActDependencies = {}) {
  let created: TandemService | undefined;
  try {
    const envelope = parseEnvelope(text);
    const run = dependencies.run ?? runCommand;
    const serviceFor = (environment: TandemBoundaryEnvironment) => (): TandemService => {
      if (dependencies.service !== undefined) return dependencies.service;
      created ??= (dependencies.createService ?? createTandemService)({
        ...serviceOptions(environment),
        run,
      });
      return created;
    };
    const { origin, action } = envelope;
    if (action.verb === "pr-fix" || "plugin" in origin)
      return await fromPlugin(envelope, dependencies, run, serviceFor);
    const located = await locate(origin, dependencies, run);
    const act: Act = { ...located, run, service: serviceFor(located.environment) };
    // The authority table's mapped type pairs each verb with its own action variant.
    const authority = VERB_AUTHORITY[action.verb] as Authority<Action>;
    if (authority.kind === "approval") {
      const refusal = await proveBlockOrigin(act, authority.views(action));
      if (refusal !== undefined) return refusal;
    }
    // The verb table's mapped type pairs each handler with its own action variant.
    const handler = HANDLERS[action.verb] as Handler<PaneAction["verb"]>;
    return await handler(act, action as never);
  } catch (error) {
    return notice("refused", "failed", message(error));
  } finally {
    await created?.shutdown();
  }
}

/**
 * A click that names a plugin, or a verb only a plugin may send. The origin alone decides, before
 * any pane is listed or service built, so a refusal cannot have changed anything.
 */
async function fromPlugin(
  { origin, action }: ActionEnvelope | PluginEnvelope,
  dependencies: NativeActDependencies,
  run: CommandRunner,
  serviceFor: (environment: TandemBoundaryEnvironment) => () => TandemService,
): Promise<Outcome> {
  if (action.verb !== "pr-fix")
    return notice(
      "refused",
      "origin-unproven",
      "The PR Guide plugin can only hand a pull request to Tandem. Nothing was changed.",
    );
  const proven = pluginOrigin(origin);
  if (typeof proven === "string") return notice("refused", "origin-unproven", proven);
  const project = await locateProject(proven.repoPath, dependencies, run);
  return handOff({ ...project, run, service: serviceFor(project.environment) }, action);
}

/** The project's environment as its one recorded coordinator names it. */
function projectEnvironment(
  base: TandemBoundaryEnvironment,
  record: CoordinatorRecord,
): TandemBoundaryEnvironment {
  return {
    ...base,
    repo: record.repoPath,
    sourceRepo: record.worktree.path,
    sessionId: record.endpoint.sessionId,
    parentWorkspaceId: record.endpoint.workspaceId,
    coordinatorPaneId: record.endpoint.paneId,
  };
}

/**
 * Proves the origin: the exact pane must be listed in exactly one recorded coordinator's session.
 * A block's echoed context names the Tandem home and the cwd it was opened for.
 */
async function locate(
  paneOrigin: ActionOrigin,
  dependencies: NativeActDependencies,
  run: CommandRunner,
): Promise<Omit<Act, "run" | "service">> {
  let home: string | undefined;
  let origin: Origin;
  let block: BlockContext | undefined;
  if ("ctx" in paneOrigin) {
    let ctx: BlockContext;
    try {
      ctx = parseBlockContext(paneOrigin.ctx);
    } catch {
      throw new Error("The view's context is not one Tandem launched it with");
    }
    block = ctx;
    home = ctx.home;
    origin = {
      paneId: paneOrigin.pane,
      cwd: ctx.cwd,
      ...(ctx.window === undefined ? {} : { windowId: ctx.window }),
    };
  } else {
    origin = {
      paneId: paneOrigin.pane,
      cwd: paneOrigin.cwd,
      ...(paneOrigin.window === undefined ? {} : { windowId: paneOrigin.window }),
    };
  }
  const base = resolveTandemEnvironment(
    dependencies.processEnvironment ?? environmentSource(),
    { cwd: dependencies.cwd ?? process.cwd(), sessionId: DEFAULT_COORDINATOR_SESSION },
    home === undefined ? {} : { home },
  );
  const terminal = dependencies.terminal ?? terminalBackend(run, { home: base.home });
  const discovery = await discoverCoordinatorRecords({ home: base.home });
  let records = discovery.records
    .filter((entry) => entry.placement === "session-directory")
    .map((entry) => entry.record);
  const cwd = await canonicalPath(origin.cwd, "native view cwd");
  const matches = records.filter(
    (record) => pathIsWithin(record.repoPath, cwd) || pathIsWithin(record.worktree.path, cwd),
  );
  // A worker's own checkout may be elsewhere in the pool. Its exact pane can still select the
  // project session; a cwd that does identify a project must agree with that pane.
  if (matches.length > 0) records = matches;
  const sessions = new Map<string, Promise<readonly PaneListing[]>>();
  for (const record of records) {
    if (!sessions.has(record.endpoint.sessionId))
      sessions.set(
        record.endpoint.sessionId,
        terminal.listPanes({
          sessionId: record.endpoint.sessionId,
          cwd: record.worktree.path,
          complete: true,
        }),
      );
  }
  const observed = await Promise.allSettled(
    records.map(async (record) => ({
      record,
      panes: await sessions.get(record.endpoint.sessionId),
    })),
  );
  const failedListings = observed.filter((result) => result.status === "rejected").length;
  records = observed.flatMap((result) =>
    result.status === "fulfilled" &&
    result.value.panes?.some((pane) => pane.paneId === origin.paneId)
      ? [result.value.record]
      : [],
  );
  const record = records[0];
  if (records.length !== 1 || record === undefined) {
    const reason =
      records.length === 0 && discovery.unreadable.length > 0
        ? ": no readable matching coordinator; unreadable records were skipped"
        : records.length === 0 && failedListings > 0
          ? ": no live matching coordinator session; its panes could not be listed"
          : "; supply its pane and cwd";
    throw new Error(`Native action context does not identify exactly one Tandem project${reason}`);
  }
  return {
    environment: projectEnvironment(base, record),
    origin,
    ...(block === undefined ? {} : { block }),
    record,
    terminal,
  };
}

/**
 * The PR Guide plugin's origin, or why the origin cannot be it. Pure: a plugin is named by its
 * manifest id and carries no pane, so nothing about the click is proved beyond the id and the
 * project. Every other origin, and every other plugin, is refused.
 */
export function pluginOrigin(origin: ActionOrigin | PluginOrigin): PluginOrigin | string {
  if (!("plugin" in origin))
    return "Only the PR Guide plugin can hand a pull request to Tandem. Nothing was changed.";
  return origin.plugin === PR_GUIDE_PLUGIN
    ? origin
    : "This request does not come from the PR Guide plugin. Nothing was changed.";
}

/**
 * The one recorded coordinator whose project is `repoPath`, across sessions. An unknown project,
 * two coordinators claiming it, or a coordinator that is not running refuses before any service
 * is built.
 */
async function locateProject(
  repoPath: string,
  dependencies: NativeActDependencies,
  run: CommandRunner,
): Promise<Omit<Project, "run" | "service">> {
  const base = resolveTandemEnvironment(dependencies.processEnvironment ?? environmentSource(), {
    cwd: dependencies.cwd ?? process.cwd(),
    sessionId: DEFAULT_COORDINATOR_SESSION,
  });
  const discovery = await discoverCoordinatorRecords({ home: base.home, repoPath });
  const records = discovery.records
    .filter((entry) => entry.placement === "session-directory")
    .map((entry) => entry.record);
  const [recorded] = records;
  if (records.length > 1) throw new Error("More than one coordinator claims this project");
  if (recorded === undefined)
    throw new Error(
      discovery.unreadable.length > 0
        ? "Tandem has no readable coordinator for this project; unreadable records were skipped"
        : "Tandem does not know this project",
    );
  const terminal = dependencies.terminal ?? terminalBackend(run, { home: base.home });
  const record = await findRunningCoordinator(run, terminal, {
    home: base.home,
    sessionId: recorded.endpoint.sessionId,
    repoPath: recorded.repoPath,
  });
  if (record === undefined)
    throw new Error("Open this project's Tandem coordinator before handing off a pull request");
  return { environment: projectEnvironment(base, record), record, terminal };
}

/**
 * What a verb may do on the user's behalf. `navigation` only shows, focuses or records what the
 * user looked at, so any pane the project's session lists may send it. `approval` approves or
 * changes scope, answers or directs work in the user's name, posts, restarts or saves settings, so
 * only one of `views(action)`, proved by `proveBlockOrigin`, may send it. `plugin` is sent by a
 * plugin's own window, which has no Tandem pane or block: `pluginOrigin` accepts only the PR Guide
 * plugin's id and `locateProject` the one recorded project it names.
 */
type Authority<A extends Action> =
  | Readonly<{ kind: "navigation" }>
  | Readonly<{ kind: "plugin" }>
  | Readonly<{ kind: "approval"; views: (action: A) => readonly ProvableView[] }>;

const NAVIGATION = { kind: "navigation" } as const;
const taskViews = (action: Readonly<{ taskId: string }>): readonly ProvableView[] => [
  { kind: "task", taskId: action.taskId },
  { kind: "pr", taskId: action.taskId },
];

/**
 * Every verb's authority, next to the verb table. The mapped type makes it exhaustive: a new verb
 * does not compile until it is classified here.
 */
export const VERB_AUTHORITY: {
  readonly [V in Action["verb"]]: Authority<Extract<Action, { verb: V }>>;
} = {
  open: NAVIGATION,
  "open-project": NAVIGATION,
  project: NAVIGATION,
  visit: NAVIGATION,
  "catchup-dismiss": NAVIGATION,
  "catchup-open-needs": NAVIGATION,
  "board-link": NAVIGATION,
  "merged-link": NAVIGATION,
  restart: { kind: "approval", views: (action) => [{ kind: "task", taskId: action.taskId }] },
  steer: { kind: "approval", views: (action) => [{ kind: "task", taskId: action.taskId }] },
  "brief-approve": {
    kind: "approval",
    views: (action) => [{ kind: "brief", requestId: action.requestId }],
  },
  "brief-request-changes": {
    kind: "approval",
    views: (action) => [{ kind: "brief", requestId: action.requestId }],
  },
  "pr-comment": { kind: "approval", views: taskViews },
  "review-submit": { kind: "approval", views: taskViews },
  // A setup block of either mode proves the click; saving then parses the answer itself.
  "setup-save": {
    kind: "approval",
    views: ({ answer }) => {
      const named = SETUP_MODES.filter((mode) => answer.mode === mode);
      return (named.length > 0 ? named : SETUP_MODES).map((mode) => ({ kind: "setup", mode }));
    },
  },
  "pr-fix": { kind: "plugin" },
};

/** Whether a verb acts on the user's behalf and so needs a proven block origin. */
export function isApprovalVerb(verb: Action["verb"]): boolean {
  return VERB_AUTHORITY[verb].kind === "approval";
}

/**
 * Why an approval-bearing click's origin cannot be this coordinator's block, or undefined when its
 * echoed context names exactly that coordinator, worktree, home and project. Pure: the terminal
 * still has to list the pane as that block.
 */
export function blockOriginProblem(
  block: BlockContext | undefined,
  originPane: string,
  expected: Readonly<{ coordinator: string; cwd: string; home: string; index: string }>,
): string | undefined {
  if (block === undefined)
    return "Only Tandem's own view can do this. Open it and make the choice there.";
  if (originPane === expected.coordinator)
    return "The conversation pane is not a Tandem view. Open the view and make the choice there.";
  return block.coordinator === expected.coordinator &&
    block.cwd === expected.cwd &&
    block.home === expected.home &&
    block.index === expected.index
    ? undefined
    : "This view belongs to another coordinator. Open it again from this project.";
}

/**
 * An approval-bearing click must come from the exact block Tandem opened for this coordinator. A
 * pane the project's session lists is not enough: a worker runs in one, knows its own id and can
 * pipe an envelope into `tandem native act`. Only Tern's listing of the pane's program and launch
 * arguments proves a block, so Herdr, which hosts none, refuses every such click.
 */
async function proveBlockOrigin(
  act: Act,
  views: readonly ProvableView[],
): Promise<Outcome | undefined> {
  const refuse = (text: string) => notice("refused", "origin-unproven", text);
  const terminal = act.terminal.views;
  if (terminal === undefined)
    return refuse(
      "Herdr has no Tandem views to prove this click came from you. Make the choice in the coordinator conversation.",
    );
  // Tern proves the recorded coordinator pane exactly before it lists the origin; the handler
  // proves the coordinator's process before it changes anything.
  const owner = act.record;
  const problem = blockOriginProblem(act.block, act.origin.paneId, {
    coordinator: owner.endpoint.paneId,
    cwd: owner.worktree.path,
    home: act.environment.home,
    index: viewIndexPath(act.environment.home, owner.repoPath),
  });
  if (problem !== undefined) return refuse(`${problem} Nothing was changed.`);
  for (const view of views) {
    let proved: boolean;
    try {
      proved = await terminal.isView({
        coordinator: owner.endpoint,
        cwd: owner.worktree.path,
        home: act.environment.home,
        origin: {
          paneId: act.origin.paneId,
          ...(act.origin.windowId === undefined ? {} : { windowId: act.origin.windowId }),
        },
        view,
      });
    } catch (error) {
      return refuse(
        `Tandem could not prove this click came from its own view: ${message(error)}. Nothing was changed.`,
      );
    }
    if (proved) return undefined;
  }
  return refuse(
    "This click did not come from this project's Tandem view for it. Open the view and make the choice there. Nothing was changed.",
  );
}

const HANDLERS: { [V in PaneAction["verb"]]: Handler<V> } = {
  open: (act, action) => open(act, action.ref),
  "open-project": async (act) => {
    const current = await ternOwner(act, "navigating");
    await act.terminal.promptAgent({
      sessionId: current.endpoint.sessionId,
      cwd: current.worktree.path,
      paneId: current.endpoint.paneId,
      text: "Help me open another project in Tandem.",
    });
    return DONE;
  },
  project: switchProject,
  visit,
  restart: async (act, action) => {
    await act.service().restart(action.taskId);
    return DONE;
  },
  steer: async (act, action) => {
    await act.service().steer({ taskId: action.taskId, text: action.text });
    return DONE;
  },
  "brief-approve": approveBrief,
  "brief-request-changes": requestChanges,
  "pr-comment": commentOnPr,
  "review-submit": submitReview,
  "catchup-dismiss": (act) => leaveCatchUp(act, false),
  "catchup-open-needs": (act) => leaveCatchUp(act, true),
  "board-link": async (act, action) => {
    const shown = await published(act, (await ternOwner(act, "using native screens")).repoPath);
    return showUrl(act, shown.boardLinks[action.cardKey]);
  },
  "merged-link": async (act, action) => {
    const shown = await published(act, (await ternOwner(act, "using native screens")).repoPath);
    return showUrl(
      act,
      shown.merged.find((url) => url === action.url),
    );
  },
  "setup-save": saveSetup,
};

/**
 * Hands a pull request to the same `pr-watch-fix` pipeline the coordinator's tool runs, mapped
 * through that tool's own strict request. That pipeline records the one owner of the branch: the
 * watch, its fix task and the fix attempt. The click is the user's own, so there is no further
 * approval; a task that could not start is `kept`, because the hand-off itself was recorded.
 */
async function handOff(project: Project, action: PluginAction): Promise<Outcome> {
  const request = prFixToolRequest(action, project.record.repoPath);
  const task = await project
    .service()
    .prWatchFix({ pullRequest: request.pullRequest, repoPath: request.repoPath });
  if (task.stage !== "blocked") return DONE;
  return notice(
    "kept",
    "failed",
    `Tandem took over ${action.repo}#${action.number}, but the fix could not start: ${task.blockReason ?? task.blockCause?.summary ?? "task is blocked"}`,
  );
}

/** What the project's last publication showed, as the store recorded it when it wrote the views. */
async function published(act: Act, repoPath: string): Promise<Published> {
  const shown = await readPublished(act.environment.home, repoPath);
  if (shown === undefined) throw new Error("This project's native views are not published yet");
  return shown;
}

function viewOutcome(result: OpenViewResult): Outcome {
  if (!result.opened) throw new Error(result.warnings.join("; ") || "The view did not open");
  return result.warnings.length === 0
    ? DONE
    : notice("kept", "view-kept", result.warnings.join("\n"));
}

/** The running coordinator of the origin's project; native navigation requires native views. */
async function ternOwner(
  act: Act,
  purpose: string,
  repoPath = act.environment.repo,
  sessionId = act.environment.sessionId,
): Promise<CoordinatorRecord> {
  const record = await findRunningCoordinator(act.run, act.terminal, {
    home: act.environment.home,
    sessionId,
    repoPath,
  });
  if (record === undefined || act.terminal.views === undefined)
    throw new Error(`Open this project's Tern coordinator before ${purpose}`);
  return record;
}

/** The running coordinator owning `repoPath` in the origin's session, of either terminal. */
async function coordinator(
  act: Act,
  repoPath: string,
  purpose = "using this action",
): Promise<CoordinatorRecord> {
  const canonical = await canonicalPath(repoPath, "repoPath");
  const discovery = await discoverCoordinatorRecords({ home: act.environment.home });
  const claimed = decideRecordedOwner(
    discovery.records
      .filter((entry) => entry.placement === "session-directory")
      .map((entry) => entry.record),
    { by: "project", sessionId: act.environment.sessionId, path: canonical, terminal: "any" },
  );
  if (claimed.status === "ambiguous")
    throw new Error("More than one coordinator claims this project");
  const owned = await findRunningCoordinator(act.run, act.terminal, {
    home: act.environment.home,
    sessionId: act.environment.sessionId,
    repoPath: claimed.status === "owned" ? claimed.record.repoPath : canonical,
  });
  if (owned === undefined) throw new Error(`Open this project's coordinator before ${purpose}`);
  return owned;
}

/** A terminal without native views refuses every open with the reason Herdr has always given. */
async function show(
  act: Act,
  owner: CoordinatorRecord,
  view: TerminalView,
  origin: Origin = act.origin,
): Promise<OpenViewResult> {
  if (act.terminal.views === undefined)
    throw new Error(
      origin.windowId === undefined
        ? `Herdr cannot display a native ${view.kind} view. Use the conversation or tandem status instead.`
        : "Herdr cannot target an opaque Tern control window key.",
    );
  return act.terminal.views.open({
    coordinator: owner.endpoint,
    cwd: owner.worktree.path,
    home: act.environment.home,
    origin,
    view,
  });
}

async function showUrl(act: Act, url: string | undefined): Promise<Outcome> {
  if (url === undefined) throw new Error("That PR is no longer in the originating project's view");
  const owner = await ternOwner(act, "using native screens");
  return viewOutcome(await show(act, owner, { kind: "browser", url }));
}

async function open(act: Act, ref: ViewRef): Promise<Outcome> {
  switch (ref.kind) {
    case "task":
    case "brief":
    case "pr":
      return openDetail(act, ref);
    case "board":
    case "usage":
      return viewOutcome(
        await show(act, await ternOwner(act, "using native screens"), { kind: ref.kind }),
      );
    case "task-picker":
      return viewOutcome(
        await show(act, await ternOwner(act, "choosing a task"), { kind: "task-picker" }),
      );
    case "prs": {
      const owner = await ternOwner(act, "showing PRs");
      const pr = (await published(act, owner.repoPath)).pullRequests[0];
      if (pr === undefined) throw new Error("This project has no cached open pull requests yet");
      return openDetail(act, { kind: "pr", repo: pr.repo, number: pr.number });
    }
    case "orchestrator":
    case "inbox": {
      const owner = await ternOwner(act, "navigating");
      const alerts =
        ref.kind === "inbox"
          ? await nativeAlertCounts(act.environment.home, owner.repoPath)
          : undefined;
      const outcome = viewOutcome(await show(act, owner, { kind: ref.kind }));
      if (alerts)
        await markNativeAlertsRead(act.environment.home, owner.repoPath, alerts.delivered);
      return outcome;
    }
    case "new-request":
      return newRequest(act);
    case "setup":
      return openSetup(act, ref.mode, ref.section);
  }
}

async function requireBriefProject(act: Act, briefRepoPath: string): Promise<void> {
  const [briefRepo, selectedRepo] = await Promise.all([
    canonicalPath(briefRepoPath, "brief repoPath"),
    canonicalPath(act.environment.repo, "selected repoPath"),
  ]);
  if (briefRepo !== selectedRepo)
    throw new Error("This brief does not belong to the selected Tandem project");
}

async function openDetail(
  act: Act,
  ref: Extract<ViewRef, { kind: "task" | "brief" | "pr" }>,
): Promise<Outcome> {
  const service = act.service();
  let view: TerminalView;
  let repoPath: string;
  if (ref.kind === "brief") {
    repoPath = (await service.requestBrief(ref.requestId)).record.repoPath;
    await requireBriefProject(act, repoPath);
    view = ref;
  } else if (ref.kind === "task") {
    const task = await service.get(ref.taskId);
    repoPath = task.repoPath;
    view = { kind: "task", taskId: task.id };
  } else {
    const task =
      ref.repo === undefined
        ? await taskForPrNumber(await service.list(), act.environment.repo, ref.number)
        : undefined;
    if (task !== undefined) {
      repoPath = task.repoPath;
      view = { kind: "pr", taskId: task.id };
    } else {
      // Watched PRs without a task are known only to the project's cached PR index.
      const owned = await coordinator(act, act.environment.repo);
      const matches = (await published(act, owned.repoPath)).pullRequests.filter(
        (entry) =>
          entry.number === ref.number && (ref.repo === undefined || entry.repo === ref.repo),
      );
      const entry = matches[0];
      if (matches.length !== 1 || entry === undefined)
        throw new Error("No unique cached pull request matches this project; open by repo#number");
      repoPath = owned.repoPath;
      view = { kind: "pr", repo: entry.repo, number: entry.number };
    }
  }
  const owned = await coordinator(act, repoPath);
  // Without native views a brief opens in the request's own review pane.
  if (
    act.terminal.views === undefined &&
    view.kind === "brief" &&
    act.origin.windowId === undefined
  ) {
    const brief = await service.reviewRequestBrief(view.requestId);
    if (brief.record.reviewPane?.status !== "open")
      throw new Error(
        brief.record.reviewPane?.reason ?? "The request brief review pane could not be opened",
      );
    return DONE;
  }
  return viewOutcome(await show(act, owned, view));
}

/** Intake stays in the coordinator conversation, where scope and approval are established. */
async function newRequest(act: Act): Promise<Outcome> {
  const owned = await coordinator(act, act.environment.repo, "starting a request");
  const target = {
    sessionId: owned.endpoint.sessionId,
    cwd: owned.worktree.path,
    paneId: owned.endpoint.paneId,
  };
  if (
    !(await act.terminal.focusAgent({
      ...target,
      origin: act.origin,
      originCoordinator: owned.endpoint,
      home: act.environment.home,
    }))
  )
    throw new Error("The coordinator could not be focused; the new request was not sent");
  const current = await coordinator(act, act.environment.repo, "starting a request");
  if (
    JSON.stringify(current.endpoint) !== JSON.stringify(owned.endpoint) ||
    current.worktree.leaseId !== owned.worktree.leaseId
  )
    throw new Error("The coordinator changed; the new request was not sent");
  await act.terminal.promptAgent({
    ...target,
    text: "I'd like to start a new request. Ask me what I want to change, then help me plan it in this conversation.",
  });
  return DONE;
}

async function switchProject(act: Act, action: Extract<Action, { verb: "project" }>) {
  const current = await ternOwner(act, "navigating");
  const model = await readPublished(act.environment.home, current.repoPath);
  const age = Date.now() - Date.parse(model?.summary.writtenAt ?? "");
  if (model === undefined || !Number.isFinite(age) || Math.abs(age) > 10_000)
    throw new Error("Project switcher is stale; wait for the coordinator snapshot");
  const currentProjects = model.projects.filter((project) => project.current);
  if (currentProjects.length !== 1 || currentProjects[0]?.repoPath !== current.repoPath)
    throw new Error("Project switcher has no unique originating project");
  const { target } = action;
  const index = model.projects.findIndex((project) => project.current);
  let number: number;
  if (typeof target === "object") {
    const named = model.projects.filter((project) => project.repoPath === target.repoPath);
    if (named.length !== 1) throw new Error("Project identity is missing or ambiguous");
    number = model.projects.findIndex((project) => project.repoPath === target.repoPath);
  } else if (typeof target === "number") number = target - 1;
  else
    number = (index + (target === "prev" ? -1 : 1) + model.projects.length) % model.projects.length;
  const project = model.projects[number];
  if (!project || project.offline || !project.sessionId)
    throw new Error("That project is offline or unavailable");
  const destination = await ternOwner(act, "navigating", project.repoPath, project.sessionId);
  const focused = await act.terminal.focusAgent({
    sessionId: destination.endpoint.sessionId,
    cwd: destination.worktree.path,
    paneId: destination.endpoint.paneId,
    origin: act.origin,
    originCoordinator: current.endpoint,
    home: act.environment.home,
  });
  if (!focused) throw new Error("Tern could not focus the exact project coordinator");
  if (destination.repoPath !== current.repoPath)
    await recordVisit(act.environment.home, current.repoPath, {
      kind: "away",
      now: new Date().toISOString(),
      signature: model.changeSignature,
    }).catch(() => {
      // Best effort: the focus already happened; a lost visit only changes the next catch-up.
    });
  const { warning } = await tryShowCatchUp(act.terminal, {
    home: act.environment.home,
    record: destination,
    ...(act.origin.windowId === undefined ? {} : { windowId: act.origin.windowId }),
  });
  return warning === undefined ? DONE : notice("done", "catch-up-unavailable", warning);
}

/** A focus event is a project entry only inside its exact recorded native session. */
async function visit(act: Act, action: Extract<Action, { verb: "visit" }>): Promise<Outcome> {
  const current = await ternOwner(act, "navigating");
  if (current.endpoint.terminalSessionId === undefined)
    throw new Error("Project visibility needs its recorded native session identity");
  const panes = await act.terminal.listPanes({
    sessionId: current.endpoint.sessionId,
    cwd: current.worktree.path,
    complete: true,
  });
  const origin = panes.find((pane) => pane.paneId === act.origin.paneId);
  if (!origin) throw new Error("Originating pane disappeared");
  await act.terminal.inspect({
    endpoint: {
      ...current.endpoint,
      paneId: origin.paneId,
      tabId: origin.tabId,
      workspaceId: origin.workspaceId,
    },
    cwd: current.worktree.path,
  });
  if (action.event !== "entry") {
    const shown = await published(act, current.repoPath);
    await recordVisit(act.environment.home, current.repoPath, {
      kind: action.event,
      now: new Date().toISOString(),
      signature: shown.changeSignature,
    });
    return DONE;
  }
  const helper = current.endpoint.notificationPane;
  if (act.origin.paneId === helper?.paneId) {
    if (helper.paneId === current.endpoint.paneId)
      throw new Error("Alert helper must be independent of its coordinator");
    await act.terminal.inspect({
      endpoint: { ...current.endpoint, ...helper },
      cwd: current.worktree.path,
    });
    const cursor = await nativeAlertCounts(act.environment.home, current.repoPath);
    const focused = await act.terminal.focusAgent({
      sessionId: current.endpoint.sessionId,
      cwd: current.worktree.path,
      paneId: current.endpoint.paneId,
      origin: act.origin,
      originCoordinator: current.endpoint,
      home: act.environment.home,
    });
    if (!focused) throw new Error("Tern could not focus the alert's exact project coordinator");
    await markNativeAlertsRead(act.environment.home, current.repoPath, cursor.delivered);
  }
  const { warning } = await tryShowCatchUp(act.terminal, {
    home: act.environment.home,
    record: current,
    ...(act.origin.windowId === undefined ? {} : { windowId: act.origin.windowId }),
  });
  return warning === undefined ? DONE : notice("done", "catch-up-unavailable", warning);
}

/** Leaving catch-up returns to the conversation even when a new publication is unreadable. */
async function leaveCatchUp(act: Act, openNeeds: boolean): Promise<Outcome> {
  const owner = await ternOwner(act, "using native screens");
  const read = published(act, owner.repoPath);
  const model = openNeeds ? await read : await read.catch(() => undefined);
  const signature = model?.changeSignature;
  if (model === undefined || signature === undefined)
    return viewOutcome(await show(act, owner, { kind: "orchestrator" }));
  let view: TerminalView = { kind: "orchestrator" };
  if (openNeeds) {
    const needs = model.needsYou[0];
    // Nothing needs the user any more; the catch-up closes as it would have after opening it.
    if (needs === undefined) return DONE;
    if (needs.cause === "brief" && needs.key.startsWith("brief:"))
      view = { kind: "brief", requestId: needs.key.slice(6) };
    else if (needs.taskId !== undefined) view = { kind: "task", taskId: needs.taskId };
    else view = { kind: "inbox" };
  }
  const outcome = viewOutcome(await show(act, owner, { kind: "orchestrator" }));
  if (view.kind !== "orchestrator")
    viewOutcome(
      await show(act, owner, view, {
        ...act.origin,
        paneId: owner.endpoint.paneId,
        cwd: owner.worktree.path,
      }),
    );
  await recordVisit(act.environment.home, owner.repoPath, {
    kind: "dismiss",
    now: new Date().toISOString(),
    signature,
  });
  return outcome;
}

async function promptCoordinator(
  act: Act,
  owned: CoordinatorRecord,
  message: string,
): Promise<void> {
  // Repeat process/endpoint proof immediately before sending user input. Never fall back to an
  // unverified inherited pane or a title when the recorded coordinator stopped in the meantime.
  const current = await coordinator(act, owned.repoPath);
  if (
    JSON.stringify(current.endpoint) !== JSON.stringify(owned.endpoint) ||
    current.worktree.leaseId !== owned.worktree.leaseId
  )
    throw new Error("The coordinator changed before feedback could be delivered; retry the action");
  await act.terminal.promptAgent({
    sessionId: current.endpoint.sessionId,
    cwd: current.worktree.path,
    paneId: current.endpoint.paneId,
    text: message,
  });
}

/** Why the native brief stayed open after its action already took effect. */
type BriefKept = Readonly<{ code: "brief-warning" | "brief-left-open"; text: string }>;

/** Completion is authoritative even when its owned native projection cannot be retired. */
async function closeNativeBrief(
  act: Act,
  owned: CoordinatorRecord,
  seen: ViewedBrief,
): Promise<BriefKept | undefined> {
  const views = act.terminal.views;
  if (views === undefined) return undefined;
  try {
    const latest = await act.service().requestBrief(seen.requestId);
    const after = briefOriginAfterAction(latest.record, seen, {
      terminal: act.terminal.name,
      paneId: act.origin.paneId,
    });
    if (after.kind === "revised")
      return {
        code: "brief-left-open",
        text: "The brief changed after this action; the current brief was left open. Do not resubmit this action.",
      };
    if (after.kind === "retired")
      return after.pane.status === "closed"
        ? undefined
        : {
            code: "brief-warning",
            text: `The action completed, but the native brief remains ${after.pane.status}: ${after.pane.reason ?? "retirement was not confirmed"}. Do not resubmit this action.`,
          };
    const result = await views.close({
      coordinator: owned.endpoint,
      cwd: owned.worktree.path,
      home: act.environment.home,
      origin: {
        paneId: act.origin.paneId,
        ...(act.origin.windowId === undefined ? {} : { windowId: act.origin.windowId }),
      },
      view: { kind: "brief", requestId: seen.requestId },
    });
    if (result.warnings.length > 0)
      return { code: "brief-warning", text: result.warnings.join("\n") };
    return result.closed
      ? undefined
      : {
          code: "brief-warning",
          text: "The action completed, but the native brief remains open. Do not resubmit this action.",
        };
  } catch (error) {
    return {
      code: "brief-warning",
      text: `The action completed, but the native brief could not be closed: ${message(error)}. Do not resubmit this action.`,
    };
  }
}

async function requestChanges(
  act: Act,
  { verb: _, text, ...seen }: Extract<Action, { verb: "brief-request-changes" }>,
): Promise<Outcome> {
  const feedback: BriefFeedback = { ...seen, ...(text === undefined ? {} : { text }) };
  assertFeedbackSize(feedback);
  const service = act.service();
  const brief = await service.requestBrief(feedback.requestId);
  await requireBriefProject(act, brief.record.repoPath);
  const prompt = briefFeedbackPrompt(brief.record, feedback, true);
  const owned = await coordinator(act, brief.record.repoPath);
  await promptCoordinator(act, owned, prompt);
  // Only a proven native brief block sends this, so there is no Herdr review pane to retire.
  const kept = await closeNativeBrief(act, owned, feedback);
  return kept === undefined ? DONE : notice("kept", kept.code, kept.text);
}

async function approveBrief(
  act: Act,
  { verb: _, ...intent }: Extract<Action, { verb: "brief-approve" }>,
): Promise<Outcome> {
  const service = act.service();
  const before = await service.requestBrief(intent.requestId);
  await requireBriefProject(act, before.record.repoPath);
  const owned = await coordinator(act, before.record.repoPath);
  // The durable compare-and-swap checks all seen fields. The action itself is the user's click.
  await service.approveRequestBrief(intent);
  const warnings: string[] = [];
  try {
    await promptCoordinator(act, owned, briefApprovedPrompt(intent));
  } catch (error) {
    warnings.push(
      `Approval was recorded, but the coordinator could not be notified: ${message(error)}`,
    );
  }
  const kept = await closeNativeBrief(act, owned, intent);
  if (kept !== undefined) return notice("kept", kept.code, [...warnings, kept.text].join("\n"));
  return warnings.length === 0 ? DONE : notice("done", "brief-warning", warnings.join("\n"));
}

async function commentOnPr(
  act: Act,
  { verb: _, taskId, ...feedback }: Extract<Action, { verb: "pr-comment" }>,
): Promise<Outcome> {
  const service = act.service();
  const before = await service.get(taskId);
  const text = await prFixRequest(before, feedback, (pr, head) =>
    readNativeThreads(act.run, { repo: pr.repository, number: pr.number }, before.repoPath, head),
  );
  const direction = await service.steer({ taskId, text });
  if (fixRequestStalled(before.stage, direction.stage)) {
    // The direction is saved, so this is not a refusal: resending would duplicate it.
    const current = await service.get(taskId);
    return notice(
      "kept",
      "feedback-saved",
      `PR feedback was saved, but the worker could not start fixing: ${current.blockReason ?? current.blockCause?.summary ?? `task is ${current.stage}`}`,
    );
  }
  return DONE;
}

/** Reuses the same pinned-head, no-double-post submission used by the PR review page. */
async function submitReview(
  act: Act,
  action: Extract<Action, { verb: "review-submit" }>,
): Promise<Outcome> {
  const parsed = parseReviewSubmission(JSON.stringify(action.submission));
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  const result = await act.service().reviewSubmit(action.taskId, parsed.submission, {
    head: action.reviewHead,
    generation: action.reviewGeneration,
  });
  if (!result.posted)
    return notice(
      "kept",
      "review-unconfirmed",
      result.message || "No posted review receipt was returned. Check the PR before trying again.",
    );
  return result.message ? notice("done", "review-posted", result.message) : DONE;
}

/** Built before publication takes the project lock, because discovery can take seconds. */
async function publishSetup(
  act: Act,
  owner: CoordinatorRecord,
  mode: SetupMode,
  section?: SetupSection,
): Promise<void> {
  const view = await act.service().setupView(owner.repoPath, mode);
  const setup = section === undefined ? view : { ...view, section };
  await publishViews(act.environment.home, owner.repoPath, async () => ({ setup }));
}

async function openSetup(act: Act, mode: SetupMode, section?: SetupSection): Promise<Outcome> {
  const owner = await ternOwner(act, "opening setup");
  if (
    mode === "settings" &&
    (await isTandemCheckout(owner.repoPath)) &&
    remainingOnboardingSteps(await act.service().onboardingFacts(owner.repoPath)).length > 0
  )
    throw new Error("Finish setting up Tandem first. Settings open once setup is saved.");
  await publishSetup(act, owner, mode, section);
  return viewOutcome(await show(act, owner, { kind: "setup", mode }));
}

/**
 * Saves the block's answer through the same workflow as every setup, publishes the new model, and
 * tells the coordinator in fixed words. A refused answer changes nothing; a partly failed save is
 * `kept`, so the block stays on screen with what went wrong.
 */
async function saveSetup(
  act: Act,
  { answer }: Extract<Action, { verb: "setup-save" }>,
): Promise<Outcome> {
  const text = JSON.stringify(answer);
  const parsed = parseSetupAnswer(text);
  if (!parsed.ok) throw new Error(`The setup answer can't be saved: ${parsed.problems.join(" ")}`);
  const { mode } = parsed.answer;
  const owner = await ternOwner(act, "saving setup");
  const result = await act.service().saveSetup(owner.repoPath, text);
  const warnings: string[] = [];
  try {
    await publishSetup(act, owner, mode);
  } catch (error) {
    warnings.push(`The saved settings could not be shown again: ${message(error)}`);
  }
  try {
    await promptCoordinator(act, owner, setupSavedMessage(mode, result));
  } catch (error) {
    warnings.push(`The coordinator could not be told: ${message(error)}`);
  }
  if (!result.complete)
    return notice("kept", "setup-incomplete", [result.message, ...warnings].join("\n"));
  return warnings.length === 0 ? DONE : notice("done", "setup-incomplete", warnings.join("\n"));
}
