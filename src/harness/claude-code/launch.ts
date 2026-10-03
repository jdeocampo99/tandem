import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSpec } from "../../contracts.ts";
import type {
  AgentProcess,
  CoordinatorLaunchIo,
  Harness,
  LaunchSpec,
  ModelRecord,
  SavedConversation,
  StartedCoordinator,
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
 * Only the Tandem plugins load: `--setting-sources project,local` keeps the Claude login but drops
 * user settings, plugins, and hooks; `--strict-mcp-config` and `--no-chrome` drop every MCP tool.
 * `--system-prompt-snapshot off` lets the adapter add context on every turn, not only the first.
 */
function coordinatorCommand(spec: LaunchSpec): readonly string[] {
  const conversation = spec.conversation;
  if (conversation.kind !== "saved" || conversation.id === undefined) {
    throw new Error("a Claude Code coordinator needs a saved conversation id");
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
    "--tools",
    "Read,AskUserQuestion",
    ...(spec.prompt === undefined ? [] : [spec.prompt]),
  ];
}

async function coordinatorConversation(
  directory: string,
  resume: boolean,
  io: CoordinatorLaunchIo,
): Promise<SavedConversation> {
  const path = conversationPointerPath(directory);
  const text = resume ? await io.readText(path) : undefined;
  const recorded = text === undefined ? undefined : parseConversationPointer(text, path);
  return { kind: "saved", directory, ...chooseConversation(recorded, resume, io.newId) };
}

function notReadyError(poolRoot: string): Error {
  return new Error(
    [
      `Claude Code started but did not load Tandem's plugin within ${READY_TIMEOUT_MS / 1000} seconds, so Tandem stopped this coordinator.`,
      "Usually Claude Code is asking whether to trust the folder, or its mods are switched off.",
      `To trust the folder, run \`claude\` once in ${poolRoot} (or a folder above it) and choose "Yes, I trust this folder"; folders inside it are then trusted too.`,
      "If mods are switched off, turn them back on in your Claude Code settings.",
      "Then run `tandem` again.",
    ].join(" "),
  );
}

/**
 * The adapter plugin starts the sidecar as Claude Code's session starts, so a sidecar answering on
 * this conversation's socket proves Claude Code trusted the folder and loaded the plugin.
 */
async function awaitCoordinatorReady(
  started: StartedCoordinator,
  io: CoordinatorLaunchIo,
  signal?: AbortSignal,
): Promise<void> {
  const { id, directory } = started.conversation;
  if (id === undefined || directory === undefined) {
    throw new Error("a Claude Code coordinator needs a saved conversation id and directory");
  }
  const socket = sidecarSocketPath(started.home, id);
  const deadline = io.now() + READY_TIMEOUT_MS;
  while (signal?.aborted !== true) {
    if (await io.answersHealth(socket)) {
      await io.writeText(conversationPointerPath(directory), `${id}\n`);
      return;
    }
    if (io.now() >= deadline) throw notReadyError(started.poolRoot);
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

/** Runs only the coordinator: the worker binding comes with issue #200, step 6. */
export const claudeCodeHarness: Harness = {
  executable: "claude",
  coordinatorFiles: [
    { name: "adapter plugin", path: ADAPTER_PLUGIN_PATH, kind: "directory" },
    { name: "renderer plugin", path: RENDERER_PLUGIN_PATH, kind: "directory" },
  ],
  // Mods stay on even when Claude Code's server-side flag would switch them off.
  launchEnvironment: { DISABLE_GROWTHBOOK: "1" },
  coordinatorConversation,
  awaitCoordinatorReady,
  command: (spec) => {
    if (spec.agent !== "coordinator") {
      throw new Error(
        `Tandem runs only the coordinator in Claude Code so far, not a ${spec.agent}. Pick a model from another provider for that role with \`tandem configure\`.`,
      );
    }
    return coordinatorCommand(spec);
  },
  sameCommand,
  looksLikeAgent,
  matchUnrecordedCoordinator,
  processNeedle: (recorded) => parseClaudeCommand(recorded)?.conversationId,
  listModels: async () => CLAUDE_CODE_MODELS,
  validateModel: (_run, _cwd, model) => validateModel(model),
  listMcpServers: async () => [],
};
