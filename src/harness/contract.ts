import type { AgentRole, CommandRunner, ModelSpec, ThinkingLevel } from "../contracts.ts";

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
export type Conversation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "saved"; directory: string | undefined; resume: boolean }>;

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

/** Whether a live process is a coordinator Tandem launched for this repository without a record. */
export type UnrecordedCoordinatorMatch = "match" | "no-match" | "unknown";

/** The launch port: everything coordinator and worker launch needs to know about one harness. */
export type Harness = Readonly<{
  /** The program every command this harness builds starts with. */
  executable: string;
  /** Files the coordinator command loads, checked before launch. */
  coordinatorFiles: Readonly<{ extensionPath: string; configPath: string }>;
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
