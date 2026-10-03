import type { AgentRole, CommandRunner, ModelSpec, ThinkingLevel } from "../contracts.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code/models.ts";

const HARNESS_NAMES = ["omp", "claude-code"] as const;
declare const harnessNameBrand: unique symbol;

export type KnownHarness = (typeof HARNESS_NAMES)[number];
/** The agent program one agent runs in, decided by its model. Parse it with `parseHarnessName`. */
export type HarnessName = KnownHarness & { readonly [harnessNameBrand]: true };

/** Reads a harness name from a saved record or job; anything else is refused. */
export function parseHarnessName(value: unknown, field: string): HarnessName {
  if (typeof value === "string" && (HARNESS_NAMES as readonly string[]).includes(value)) {
    return value as HarnessName;
  }
  throw new TypeError(
    `${field} must be ${HARNESS_NAMES.map((name) => JSON.stringify(name)).join(" or ")}, not ${JSON.stringify(value)}`,
  );
}

/** What every model outside Claude Code runs in, and what anything saved without a harness ran in. */
export const DEFAULT_HARNESS: HarnessName = parseHarnessName("omp", "harness");

const CLAUDE_CODE: HarnessName = parseHarnessName("claude-code", "harness");

/**
 * The one place a model becomes a harness: a `claude-code/<model>` selector runs in Claude Code,
 * and every other selector, or no model at all (the harness's own default), runs in OMP.
 */
export function harnessOf(model: ModelSpec | undefined): HarnessName {
  return model?.model.startsWith(`${CLAUDE_CODE_PROVIDER}/`) ? CLAUDE_CODE : DEFAULT_HARNESS;
}

/**
 * What one request on this model draws from a subscription's included allowance, in the
 * provider's own units. It carries no currency: an included draw is quota consumption, and
 * pricing it would invent a charge the provider never billed.
 */
export type IncludedAllowance = Readonly<{
  plan: string;
  unit: string;
  unitsPerRequest: number;
}>;

export type ModelRecord = Readonly<{
  selector: string;
  id: string;
  provider: string;
  thinking: readonly ThinkingLevel[];
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  /** Descriptive catalogue pricing; it is evidence about the model, not this account's rate. */
  cost?: Readonly<{
    input: number;
    output: number;
  }>;
  includedAllowance?: IncludedAllowance;
}>;

/**
 * The agent being launched, which decides its tools. Each harness names the tools its own way.
 * A pr-reviewer is a reviewer that may also run read-only git and gh commands.
 */
export type AgentKind = AgentRole | "pr-reviewer";

/** Where the agent keeps its conversation. */
export type Conversation = Readonly<{ kind: "none" }> | SavedConversation;

export type SavedConversation = Readonly<{
  kind: "saved";
  directory: string | undefined;
  resume: boolean;
  /** Claude Code names a conversation by this id; OMP finds it by `directory` and ignores it. */
  id?: string;
}>;

export type LaunchSpec = Readonly<{
  agent: AgentKind;
  cwd: string;
  /** Unset runs the harness's own default model. */
  model: ModelSpec | undefined;
  conversation: Conversation;
  prompt?: string;
}>;

export type AgentProcess = Readonly<{
  name: string;
  argv: readonly string[];
  argv0: string | undefined;
}>;

/** A file or directory the coordinator command loads, checked before launch. */
export type CoordinatorFile = Readonly<{
  /** How checks name it; the CLI's `--extension` and `--config` confirm the files so named. */
  name: string;
  path: string;
  kind: "file" | "directory";
}>;

/** The effects a coordinator launch lends its harness, injected so the harness's decisions stay testable. */
export type CoordinatorLaunchIo = Readonly<{
  /** The file's text, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  newId(): string;
  /** Whether something answers `GET /health` on this unix socket. */
  answersHealth(socket: string): Promise<boolean>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /** Milliseconds on a monotonic clock. */
  now(): number;
}>;

/** A coordinator whose command has just started, as its ready handshake needs it. */
export type StartedCoordinator = Readonly<{
  home: string;
  poolRoot: string;
  conversation: SavedConversation;
}>;

/** Whether a live process is a coordinator Tandem launched for this repository without a record. */
export type UnrecordedCoordinatorMatch = "match" | "no-match" | "unknown";

/** The launch port: everything coordinator and worker launch needs to know about one harness. */
export type Harness = Readonly<{
  /** The program every command this harness builds starts with. */
  executable: string;
  coordinatorFiles: readonly CoordinatorFile[];
  /** Environment the coordinator needs beyond Tandem's own, in its pane and in a direct run. */
  launchEnvironment: Readonly<Record<string, string>>;
  /** The conversation a coordinator launch names, from what an earlier launch kept in `directory`. */
  coordinatorConversation(
    directory: string,
    resume: boolean,
    io: CoordinatorLaunchIo,
  ): Promise<SavedConversation>;
  /**
   * Resolves once the started coordinator has loaded Tandem, and keeps its conversation for the
   * next launch to resume; rejects in plain English when it does not. An aborted wait resolves.
   */
  awaitCoordinatorReady(
    started: StartedCoordinator,
    io: CoordinatorLaunchIo,
    signal?: AbortSignal,
  ): Promise<void>;
  command(spec: LaunchSpec): readonly string[];
  /** False unless both commands provably launch the same agent; resuming does not distinguish. */
  sameCommand(live: readonly string[], recorded: readonly string[]): boolean;
  looksLikeAgent(process: AgentProcess): boolean;
  matchUnrecordedCoordinator(
    argv: readonly string[],
    expected: Readonly<{ repoPath: string; sessionDirectory: string }>,
  ): Promise<UnrecordedCoordinatorMatch>;
  /** Text that appears in the `ps` line of any process still running this recorded command. */
  processNeedle(recorded: readonly string[]): string | undefined;
  listModels(run: CommandRunner, cwd: string): Promise<readonly ModelRecord[]>;
  /** The listed model the spec names, or an error when it is missing or lacks the thinking level. */
  validateModel(run: CommandRunner, cwd: string, model: ModelSpec): Promise<ModelRecord>;
  listMcpServers(cwd: string): Promise<readonly string[]>;
}>;
