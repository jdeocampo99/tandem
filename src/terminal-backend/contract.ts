import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { AgentRole, Endpoint, TerminalName } from "../contracts.ts";
import type { SetupMode } from "../onboarding/setup-view.ts";
import type { ToolCheck } from "../onboarding/tools.ts";

/** A pane Tandem owns, and the directory the backend's commands run from. */
export type EndpointTarget = Readonly<{ endpoint: Endpoint; cwd: string }>;

/** A session-wide request, and the directory the backend's commands run from. */
export type SessionTarget = Readonly<{ sessionId: string; cwd: string }>;
export type ForegroundProcess = Readonly<{
  pid: number;
  name: string;
  argv: readonly string[];
  argv0: string | undefined;
  commandLine: string | undefined;
}>;

export type ProcessInfo = Readonly<{
  paneId: string;
  shellPid: number | undefined;
  foregroundProcessGroupId: number | undefined;
  foregroundProcesses: readonly ForegroundProcess[];
}>;

/** Where the terminal says a pane is, and the directory its foreground program runs in. */
export type PaneIdentity = Readonly<{
  paneId: string;
  tabId: string;
  workspaceId: string;
  foregroundCwd: string | undefined;
}>;

export type EndpointInspection = Readonly<{
  endpoint: Endpoint;
  pane: PaneIdentity;
  processInfo: ProcessInfo;
  /** Some foreground process is not the pane's shell. */
  activeWorker: boolean;
}>;

/** A workspace as the terminal lists it, in sidebar order. */
export type WorkspaceListing = Readonly<{
  workspaceId: string;
  label?: string;
  activeTabId?: string;
}>;

export type PaneListing = Readonly<{
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  foregroundCwd?: string;
}>;

/** One pane in a whole-session snapshot, with the agent state the terminal tracks for it. */
export type SessionPane = Readonly<{
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentStatus?: string;
}>;

export type FocusResult =
  | Readonly<{ focused: true }>
  | Readonly<{ focused: false; code: number; detail: string }>;

/** A durable identity to show. The CLI validates it before asking a backend to present it. */
export type TerminalView =
  | Readonly<{ kind: "browser"; url: string }>
  | Readonly<{
      kind:
        | "board"
        | "usage"
        | "prs"
        | "catchup"
        | "orchestrator"
        | "inbox"
        | "task-picker"
        | "quick-task";
    }>
  | Readonly<{ kind: "task" | "pr"; taskId: string }>
  | Readonly<{ kind: "brief"; requestId: string }>
  | Readonly<{ kind: "pr"; repo: string; number: number }>
  | Readonly<{ kind: "setup"; mode: SetupMode }>;

/** Presentation context from the initiating view; it grants no pane ownership. */
export type ViewOrigin = Readonly<{ paneId?: string; windowId?: string; cwd?: string }>;

/** A native view open whose outcome was never proved, so it pauses new opens for its owner. */
export type RetainedViewOpen =
  | Readonly<{
      status: "readable";
      path: string;
      /** The record exactly as listed, so an abandon never removes one that changed since. */
      record: string;
      coordinator: Endpoint;
      cwd: string;
      view: string;
      /** Why the open is still unproven, in the user's terms. */
      reason: string;
    }>
  | Readonly<{ status: "unreadable"; path: string; reason: string }>;

/** A pane whose last Tandem effect ended with an unknown outcome, so Tandem refuses to touch it. */
export type QuarantinedPane =
  | Readonly<{
      status: "readable";
      path: string;
      /** The record exactly as listed, so a clear never removes one that changed since. */
      record: string;
      key: string;
      operation: string;
      reason: string;
      at: string;
      endpoint: Endpoint;
      cwd: string;
    }>
  | Readonly<{ status: "unreadable"; path: string; reason: string }>;

export type OpenViewResult = Readonly<{
  opened: boolean;
  warnings: readonly string[];
  /** Exact native brief split identity, for its request workflow's scoped retirement. */
  endpoint?: Endpoint;
}>;

/**
 * Native views hosted beside a coordinator. A terminal that cannot host them omits the capability,
 * so callers branch on its presence rather than on the terminal's name.
 */
export type ViewsCapability = Readonly<{
  /** Opens a brief/PR split or replaces the main area with a task view beside this coordinator.
   * Supplied origin window/pane context must be honored or refused; never target another window.
   * A windowId is an opaque control window key. Without it, derive the unique owning control
   * window from the exact origin pane or refuse ambiguous mutation; never select the first window.
   */
  open(
    input: Readonly<{
      coordinator: Endpoint;
      cwd: string;
      home: string;
      view: TerminalView;
      origin?: ViewOrigin;
    }>,
  ): Promise<OpenViewResult>;
  /** Retires only the originating native brief split. The caller owns revision/action policy.
   * Missing panes count as closed; foreign, busy and unknown outcomes retain the pane.
   * This never retires a process-oriented Markdown reviewPane or the conversation.
   */
  close(
    input: Readonly<{
      coordinator: Endpoint;
      cwd: string;
      home: string;
      origin: ViewOrigin & Readonly<{ paneId: string }>;
      view: Extract<TerminalView, { kind: "brief" }>;
    }>,
  ): Promise<Readonly<{ closed: boolean; warnings: readonly string[] }>>;
  /** Settles every retained native view open under `home` whose outcome is now proved. */
  recover(home: string): Promise<void>;
  /**
   * Native view opens under `home` whose outcome was never proved, read without changing them.
   * Throws when the opens themselves cannot be listed.
   */
  retained(home: string): Promise<readonly RetainedViewOpen[]>;
  /**
   * Removes one retained open's records, never a pane, under that open's lock: only while the
   * record is unchanged and `conclusive` re-proves its coordinator's state.
   */
  abandon(
    open: Extract<RetainedViewOpen, Readonly<{ status: "readable" }>>,
    conclusive: () => Promise<boolean>,
  ): Promise<"abandoned" | "settled" | "changed" | "unproven">;
}>;

/** The last proven window width, and any limitation that prevented fitting the panel. */
export type PanelFitResult = Readonly<{
  fittedWidth: number | undefined;
  warnings: readonly string[];
}>;

export type AgentState = "idle" | "working" | "blocked" | "unknown";

/** Presentation-only lifecycle state for the pane an agent runs in; it never grants ownership. */
export type AgentStatusReporter = Readonly<{
  report: (state: AgentState, message?: string) => Promise<void>;
  release: () => Promise<void>;
}>;

/** What a process's environment says about the terminal pane it runs in. */
export type InheritedPane =
  | Readonly<{ status: "outside" }>
  | Readonly<{ status: "inside"; sessionId: string; workspaceId: string; paneId: string }>
  | Readonly<{ status: "invalid"; reason: string }>;

/** Where the terminal's focus is, as it tells a command it starts; either part may be unknown. */
export type TerminalFocus = Readonly<{ workspaceId?: string; cwd?: string }>;

export type SplitAnchor =
  | Readonly<{ anchor: Endpoint }>
  | Readonly<{ sessionId: string; anchorPaneId: string }>;

/**
 * The terminal port: every pane, workspace, and session effect Tandem has. Implementations are
 * bound to one command runner. Failures that a caller decides on are typed: a missing pane is an
 * `EndpointOwnershipError` with reason "missing", a pane someone else now owns is an
 * `EndpointOwnershipError`, and an active worker that blocks a close or outlives an interrupt is an
 * `EndpointBusyError`. Every operation that names a pane takes its full identity and refuses a
 * pane whose session, workspace, or tab no longer match.
 */
export type TerminalBackend = Readonly<{
  /** What doctor checks and messages call this terminal. */
  name: TerminalName;

  /** Reads the pane's identity and foreground processes, proving it is still `endpoint`. */
  inspect(target: EndpointTarget): Promise<EndpointInspection>;
  /**
   * Types `command` into the pane's shell and runs it. It does not inspect the pane first; prove a
   * pane Tandem did not just create with `inspect`.
   */
  runCommand(
    target: EndpointTarget &
      Readonly<{ command: readonly string[]; env?: Readonly<Record<string, string>> }>,
  ): Promise<void>;
  /** Sends key chords, such as a harness's exit keys, in one burst. */
  sendKeys(target: EndpointTarget & Readonly<{ keys: readonly string[] }>): Promise<void>;
  /**
   * Stops the pane's foreground program with `key` (ctrl+c by default) and waits until only the
   * shell is left; a pane that was idle gets no key. Throws `EndpointBusyError` on timeout.
   */
  interrupt(
    target: EndpointTarget &
      Readonly<{ key?: string; timeoutMs?: number; pollIntervalMs?: number }>,
  ): Promise<Readonly<{ wasRunning: boolean }>>;
  /**
   * Closes a pane Tandem owns, then proves the exact pane is gone. A pane already gone counts as
   * closed. An active worker is refused with `EndpointBusyError` before anything reaches the
   * terminal, unless `force` says the user chose to discard its work. Closing a workspace's last
   * pane must remove the workspace.
   */
  close(target: EndpointTarget & Readonly<{ force?: boolean }>): Promise<void>;
  /**
   * Closes a pane whose ownership the caller has already proven, whatever runs in it. Requires the
   * terminal to confirm the close, then proves the exact pane is gone. Any close the terminal
   * refuses fails, including one for a pane it can no longer find; a caller that counts that pane
   * as closed checks `isPaneGone`. With `strictProof`, only the terminal's structured not-found
   * answer proves the pane is gone.
   */
  closeOwned(target: EndpointTarget & Readonly<{ strictProof?: boolean }>): Promise<void>;
  /** Whether an error from this backend means the pane itself no longer exists. */
  isPaneGone(error: unknown): boolean;
  /** Whether an error from this backend means the pane, or its tab, workspace, or session, no longer exists. */
  isEndpointGone(error: unknown): boolean;

  /** Creates a workspace with one pane in `cwd`, without focus, and nests it after a parent. */
  createWorkspace(
    target: SessionTarget &
      Readonly<{
        label: string;
        role: AgentRole;
        generation: number;
        env?: Readonly<Record<string, string>>;
        parentWorkspaceId?: string;
        insertIndex?: number;
        /** Previous durable identity, when reconnecting to a retained native project session. */
        previousEndpoint?: Endpoint;
      }>,
  ): Promise<Readonly<{ endpoint: Endpoint; warnings: readonly string[] }>>;
  /**
   * Opens a pane beside an anchor, without focus, proven to share its workspace and tab. An
   * anchor known only by pane id is read first; nothing is ever written to the anchor.
   */
  splitBeside(
    input: SplitAnchor & Readonly<{ cwd: string; role: AgentRole; generation: number }>,
  ): Promise<Endpoint>;

  /**
   * The session's workspaces in sidebar order. With `complete`, every entry must name its active
   * tab and label, or the whole listing fails.
   */
  listWorkspaces(
    target: SessionTarget & Readonly<{ complete?: boolean }>,
  ): Promise<readonly WorkspaceListing[]>;
  /**
   * Moves a workspace directly after its parent in the sidebar. Never throws: whatever stops the
   * move comes back as a warning and the workspace stays where it is.
   */
  orderWorkspaceAfter(
    target: SessionTarget &
      Readonly<{ workspaceId: string; parentWorkspaceId: string; insertIndex?: number }>,
  ): Promise<readonly string[]>;
  /** The workspace's label, or undefined when the workspace or its session is gone. */
  workspaceLabel(
    target: SessionTarget & Readonly<{ workspaceId: string }>,
  ): Promise<string | undefined>;
  /** Relabels a workspace, and fails unless the terminal confirms the new label. */
  renameWorkspace(
    target: SessionTarget & Readonly<{ workspaceId: string; label: string }>,
  ): Promise<void>;
  /**
   * Panes in the session, or in one workspace. Entries the terminal cannot fully describe are left
   * out; with `complete`, any such entry fails the whole listing instead.
   */
  listPanes(
    target: SessionTarget & Readonly<{ workspaceId?: string; complete?: boolean }>,
  ): Promise<readonly PaneListing[]>;
  /** Every pane in the session; with `allowMissingSession`, a session that is not running has none. */
  snapshot(
    target: SessionTarget & Readonly<{ allowMissingSession?: boolean }>,
  ): Promise<readonly SessionPane[]>;
  focusWorkspace(
    target: SessionTarget &
      Readonly<{ workspaceId: string; env?: Readonly<Record<string, string>> }>,
  ): Promise<FocusResult>;
  /** Focuses the exact pane; false when the terminal would not, which callers may ignore. */
  focusAgent(
    target: SessionTarget &
      Readonly<{
        paneId: string;
        origin?: ViewOrigin;
        originCoordinator?: Endpoint;
        home?: string;
      }>,
  ): Promise<boolean>;

  /** Native view hosting; absent when the terminal has none. */
  views?: ViewsCapability | undefined;
  /**
   * Panes Tandem refuses to touch because an effect there ended with an unknown outcome, read
   * without changing them. Throws when the records themselves cannot be listed.
   */
  quarantinedPanes(home: string): Promise<readonly QuarantinedPane[]>;
  /**
   * Removes one pane's quarantine record, never the pane, under the record's lock: only while
   * the record is unchanged and `conclusive` re-proves the pane gone or idle.
   */
  clearPaneQuarantine(
    pane: Extract<QuarantinedPane, Readonly<{ status: "readable" }>>,
    conclusive: () => Promise<boolean>,
  ): Promise<"cleared" | "settled" | "changed" | "unproven">;

  /** Whether the session's server runs; throws when the terminal cannot say. */
  sessionRunning(target: SessionTarget): Promise<boolean>;
  /** The terminal's own description of the session, for `doctor`. */
  sessionDetail(target: SessionTarget): Promise<string>;
  /** The command that starts the session's server with no window. */
  serverCommand(sessionId: string): readonly string[];
  /** The command that opens the session in this terminal window, starting it if needed. */
  clientCommand(sessionId: string): readonly string[];
  /** Whether the terminal, and Tandem's integration with it, are installed for onboarding. */
  checkInstall(target: SessionTarget): Promise<readonly ToolCheck[]>;

  /** Tells the user something new needs them, through the terminal's notification settings. */
  notify(target: SessionTarget & Readonly<{ title: string; body: string }>): Promise<void>;
  /** Opens Tandem's welcome view; accepting it prompts the agent in `paneId`. */
  openWelcome(target: SessionTarget & Readonly<{ paneId: string }>): Promise<void>;
  /**
   * Opens Tandem's setup block beside the coordinator in `paneId`, which must already have its
   * published view; false when this terminal has no native blocks and setup runs in the chat.
   */
  openSetup(target: SessionTarget & Readonly<{ paneId: string }>): Promise<boolean>;
  /** Submits a prompt to the agent in a pane, or types it and presses Enter when none is known. */
  promptAgent(target: SessionTarget & Readonly<{ paneId: string; text: string }>): Promise<void>;
  /** Opens Tandem's panel beside the coordinator, without focus; its pane id. */
  openPanel(
    input: Readonly<{ coordinator: Endpoint; cwd: string; project: string }>,
  ): Promise<string>;
  /** Whether `panelPaneId` is still the panel in the coordinator's workspace. */
  isPanelOpen(
    input: Readonly<{ coordinator: Endpoint; cwd: string; panelPaneId: string }>,
  ): Promise<boolean>;
  /** Closes a panel; one already gone counts as closed. */
  closePanel(target: SessionTarget & Readonly<{ panelPaneId: string }>): Promise<void>;
  /**
   * Brings the panel back to `columns` wide, once per window width. Retains `fittedWidth` when
   * nothing changed or fitting was refused; terminals can report a limitation as a warning.
   */
  fitPanel(
    target: SessionTarget &
      Readonly<{ paneId: string; columns: number; fittedWidth: number | undefined }>,
  ): Promise<PanelFitResult>;
  /** Publishes the agent's state on the pane this process inherited, or undefined outside one. */
  agentStatusReporter(
    input: Readonly<{
      cwd: string;
      agentLabel: string;
      environment?: TandemEnvironmentSource;
      timeoutMs?: number;
    }>,
  ): AgentStatusReporter | undefined;
}>;

/**
 * What a process's environment says about the terminal pane it runs in. Pure, so it is imported
 * rather than injected.
 */
export type TerminalContext = Readonly<{
  /** The variables that tie a process to its pane: copied into snapshots, cleared for launches. */
  variables: readonly string[];
  /**
   * The pane this process runs in, its values exactly as the environment holds them; "invalid"
   * when the variables disagree, so nothing guesses.
   */
  inheritedPane(environment: TandemEnvironmentSource): InheritedPane;
  /**
   * Whether this process runs in one of the terminal's own windows, so focusing a coordinator
   * shows it there and no client needs to open.
   */
  inWindow(environment: TandemEnvironmentSource): boolean;
  /** The session named by the environment, even outside an active pane. */
  sessionName(environment: TandemEnvironmentSource): string | undefined;
  /** The workspace named by the environment, even outside an active pane. */
  workspaceId(environment: TandemEnvironmentSource): string | undefined;
  /** The pane this process runs in, only when it belongs to `sessionId`. */
  paneInSession(environment: TandemEnvironmentSource, sessionId: string): string | undefined;
  /** Where the terminal's focus was when it started this command. */
  focus(environment: TandemEnvironmentSource): TerminalFocus;
  /** The panel's own pane, when this process is the panel the terminal opened beside a coordinator. */
  panelPaneId(environment: TandemEnvironmentSource): string | undefined;
  /** The agent pane targeted by the welcome view, when this process hosts that view. */
  welcomePaneId(environment: TandemEnvironmentSource): string | undefined;
}>;

const SHELL_PROCESS_NAMES: Readonly<Record<string, true>> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  fish: true,
};

function processBasename(value: string): string {
  const withoutPath = value.split("/").at(-1) ?? value;
  return withoutPath.replace(/^-/, "").toLowerCase();
}

/** A foreground process that is not a login or interactive shell. */
export function isWorkerProcess(process: ForegroundProcess): boolean {
  const name = processBasename(process.name);
  const argv0 = process.argv0 === undefined ? undefined : processBasename(process.argv0);
  return (
    SHELL_PROCESS_NAMES[name] !== true ||
    (argv0 !== undefined && SHELL_PROCESS_NAMES[argv0] !== true)
  );
}
