import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSpec } from "../../contracts.ts";
import type {
  AgentKind,
  AgentProcess,
  Harness,
  LaunchIo,
  LaunchSpec,
  ModelRecord,
  SavedConversation,
  StartedAgent,
  UnrecordedCoordinatorMatch,
} from "../contract.ts";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER } from "./models.ts";
import { sidecarSocketPath } from "./socket.ts";

const PLUGINS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "plugins");
/** The adapter mod: it starts the sidecar and forwards Claude Code's hooks to it. */
const ADAPTER_PLUGIN_PATH = join(PLUGINS_DIRECTORY, "tandem");
/** Hides the prompts the adapter submits for Tandem, so the pane shows only what the user typed. */
const RENDERER_PLUGIN_PATH = join(PLUGINS_DIRECTORY, "tandem-renderer");
/** Under the coordinator's conversation directory: the id of the conversation a resume continues. */
const CONVERSATION_FILE = "claude-code-conversation";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const CONVERSATION_FLAGS: readonly string[] = ["--session-id", "--resume"];
const REPEATABLE_FLAGS: readonly string[] = ["--plugin-dir"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Resuming continues the recorded conversation. A fresh launch, or a resume with nothing
 * recorded, starts a new one.
 */
export function chooseConversation(
  recorded: string | undefined,
  resume: boolean,
  newId: () => string,
): Readonly<{ id: string; resume: boolean }> {
  return resume && recorded !== undefined
    ? { id: recorded, resume: true }
    : { id: newId(), resume: false };
}

/** The conversation id a pointer file holds; anything else fails closed. */
export function parseConversationPointer(text: string, path: string): string {
  const id = text.trim();
  if (!UUID.test(id)) {
    throw new Error(
      `${path} does not hold a Claude Code conversation id, so Tandem can't tell which conversation to continue. Run \`tandem --fresh\` to start a new one.`,
    );
  }
  return id;
}

function conversationPointerPath(directory: string): string {
  return join(directory, CONVERSATION_FILE);
}

/** The real path, or the resolved one when nothing exists there. */
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function isClaude(value: string | undefined): boolean {
  return value !== undefined && basename(value) === "claude";
}

type ClaudeCommand = Readonly<{ conversationId: string; normalized: readonly string[] }>;

/**
 * Reads a `claude` command naming exactly one conversation with no flag given twice. Its
 * conversation flag is spelled one way, since `--session-id X` and `--resume X` run the same
 * conversation.
 */
function parseClaudeCommand(argv: readonly string[]): ClaudeCommand | undefined {
  if (!isClaude(argv[0])) return undefined;
  const normalized = ["claude"];
  const seen = new Set<string>();
  let conversationId: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value.startsWith("--")) {
      if (seen.has(value) && !REPEATABLE_FLAGS.includes(value)) return undefined;
      seen.add(value);
    }
    if (!CONVERSATION_FLAGS.includes(value)) {
      normalized.push(value);
      continue;
    }
    const next = argv[index + 1];
    if (conversationId !== undefined || next === undefined || next.startsWith("-")) {
      return undefined;
    }
    conversationId = next;
    normalized.push("\0conversation", next);
    index += 1;
  }
  return conversationId === undefined ? undefined : { conversationId, normalized };
}

function modelFlags(model: ModelSpec | undefined): readonly string[] {
  if (model === undefined) return [];
  const alias = model.model.slice(`${CLAUDE_CODE_PROVIDER}/`.length);
  return ["--model", alias, ...(model.thinking === "off" ? [] : ["--effort", model.thinking])];
}

/**
 * Claude Code's built-in tools for each agent, mirroring OMP's. Write, Edit, and `copy_asset` reach
 * only the mockup folder Tandem names (see mockupWriteDecision), and a PR review's Bash runs only
 * read-only commands; the adapter's tool guard enforces both. `submit_report`, `copy_asset`, and
 * the coordinator's `tandem` are the adapter's own tools, which the plugin adds.
 */
const TOOLS: Readonly<Record<AgentKind, readonly string[]>> = {
  coordinator: ["Read", "AskUserQuestion"],
  scout: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent", "Write", "Edit"],
  reviewer: ["Read", "Grep", "Glob"],
  "pr-reviewer": ["Read", "Grep", "Glob", "Bash"],
  implementer: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "TodoWrite"],
  presentation: ["Read", "Grep", "Glob", "Write", "Edit"],
};

/**
 * Only the Tandem plugins load: `--setting-sources project,local` keeps the Claude login but drops
 * user settings, plugins, and hooks; `--strict-mcp-config` and `--no-chrome` drop every MCP tool.
 * `--system-prompt-snapshot off` lets the adapter add context on every turn, not only the first.
 * A worker runs unattended, as on OMP: Claude Code asks no permission, and Tandem's tool guard
 * decides instead.
 */
function agentCommand(spec: LaunchSpec): readonly string[] {
  const conversation = spec.conversation;
  if (conversation.kind !== "saved" || conversation.id === undefined) {
    throw new Error(`a Claude Code ${spec.agent} needs a conversation id`);
  }
  return [
    "claude",
    "--plugin-dir",
    ADAPTER_PLUGIN_PATH,
    "--plugin-dir",
    RENDERER_PLUGIN_PATH,
    conversation.resume ? "--resume" : "--session-id",
    conversation.id,
    ...modelFlags(spec.model),
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--no-chrome",
    "--disable-slash-commands",
    "--system-prompt-snapshot",
    "off",
    ...(spec.agent === "coordinator" ? [] : ["--permission-mode", "bypassPermissions"]),
    "--tools",
    TOOLS[spec.agent].join(","),
    ...(spec.prompt === undefined ? [] : [spec.prompt]),
  ];
}

/**
 * Every Claude Code agent names its conversation, because its sidecar's socket is named by it.
 * Only one with a directory keeps the id there for a later launch to resume.
 */
async function conversation(
  {
    home,
    directory,
    resume,
  }: Readonly<{ home: string; directory: string | undefined; resume: boolean }>,
  io: LaunchIo,
): Promise<SavedConversation> {
  const path = directory === undefined ? undefined : conversationPointerPath(directory);
  const text = resume && path !== undefined ? await io.readText(path) : undefined;
  const recorded =
    text === undefined || path === undefined ? undefined : parseConversationPointer(text, path);
  const conversation = chooseConversation(recorded, resume, io.newId);
  // A home too long for the sidecar's socket is refused before anything starts.
  sidecarSocketPath(home, conversation.id);
  return { kind: "saved", directory, ...conversation };
}

function notReadyError(agent: AgentKind, repo: string): Error {
  return new Error(
    [
      `Claude Code started but did not load Tandem's plugin within ${READY_TIMEOUT_MS / 1000} seconds, so Tandem stopped this ${agent}.`,
      "Usually Claude Code is asking whether to trust the project, or its mods are switched off.",
      `To trust the project, run \`claude\` once in ${repo} and choose "Yes, I trust this folder"; Tandem's worktrees of the project are then trusted too.`,
      "If mods are switched off, check that no Claude Code settings file sets `disableAllHooks`.",
      agent === "coordinator" ? "Then run `tandem` again." : "Then restart the task.",
    ].join(" "),
  );
}

/**
 * The adapter plugin starts the sidecar as Claude Code's session starts, so a sidecar answering on
 * this conversation's socket proves Claude Code trusted the project and loaded the plugin.
 */
async function awaitReady(
  started: StartedAgent,
  io: LaunchIo,
  signal?: AbortSignal,
): Promise<void> {
  const { agent, conversation } = started;
  if (conversation.kind !== "saved" || conversation.id === undefined) {
    throw new Error(`a Claude Code ${agent} needs a conversation id`);
  }
  const { id, directory } = conversation;
  const socket = sidecarSocketPath(started.home, id);
  const deadline = io.now() + READY_TIMEOUT_MS;
  while (signal?.aborted !== true) {
    if (await io.answersHealth(socket)) {
      if (directory !== undefined) {
        await io.writeText(conversationPointerPath(directory), `${id}\n`);
      }
      return;
    }
    if (io.now() >= deadline) throw notReadyError(agent, started.repo);
    await io.sleep(READY_POLL_MS, signal);
  }
}

function sameCommand(live: readonly string[], recorded: readonly string[]): boolean {
  const normalizedLive = parseClaudeCommand(live)?.normalized;
  const normalizedRecorded = parseClaudeCommand(recorded)?.normalized;
  return (
    normalizedLive !== undefined &&
    normalizedRecorded !== undefined &&
    normalizedLive.length === normalizedRecorded.length &&
    normalizedLive.every((value, index) => value === normalizedRecorded[index])
  );
}

/** A native install runs a versioned binary, so only argv[0] still says `claude`. */
function looksLikeAgent(process: AgentProcess): boolean {
  return [process.argv[0], process.name, process.argv0].some(isClaude);
}

/**
 * A Claude Code coordinator names no repository on its command line, so one loading Tandem's
 * adapter plugin can never be proven to belong to this repository or to another.
 */
async function matchUnrecordedCoordinator(
  argv: readonly string[],
): Promise<UnrecordedCoordinatorMatch> {
  if (!isClaude(argv[0])) return "unknown";
  const adapter = await canonicalPath(ADAPTER_PLUGIN_PATH);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== "--plugin-dir") continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) return "unknown";
    if ((await canonicalPath(value)) === adapter) return "unknown";
  }
  return "no-match";
}

async function validateModel(model: ModelSpec): Promise<ModelRecord> {
  const record = CLAUDE_CODE_MODELS.find((candidate) => candidate.selector === model.model);
  if (record === undefined) {
    throw new Error(
      `selector ${JSON.stringify(model.model)} is not one of Claude Code's models: ${CLAUDE_CODE_MODELS.map((candidate) => candidate.selector).join(", ")}`,
    );
  }
  if (!record.thinking.includes(model.thinking)) {
    throw new Error(
      `selector ${JSON.stringify(model.model)} does not support thinking ${JSON.stringify(model.thinking)}`,
    );
  }
  return record;
}

const NESTED_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
] as const;

export const claudeCodeHarness: Harness = {
  executable: "claude",
  displayName: "Claude Code",
  coordinatorFiles: [
    { name: "adapter plugin", path: ADAPTER_PLUGIN_PATH, kind: "directory" },
    { name: "renderer plugin", path: RENDERER_PLUGIN_PATH, kind: "directory" },
  ],
  // Mods stay on even when Claude Code's server-side flag would switch them off.
  launchEnvironment: { DISABLE_GROWTHBOOK: "1" },
  // Claude Code marks the processes it runs as its children; an agent that inherits the marks
  // (Tandem launched from inside Claude Code) saves no transcript, so it could never be resumed.
  clearedEnvironment: NESTED_SESSION_VARIABLES,
  // The first Ctrl-D only asks "Press Ctrl-D again to exit" (2.1.288).
  exitKeys: ["ctrl+d", "ctrl+d"],
  conversation,
  awaitReady,
  command: agentCommand,
  sameCommand,
  looksLikeAgent,
  matchUnrecordedCoordinator,
  processNeedle: (recorded) => parseClaudeCommand(recorded)?.conversationId,
  listModels: async () => CLAUDE_CODE_MODELS,
  validateModel: (_run, _cwd, model) => validateModel(model),
  listMcpServers: async () => [],
};
