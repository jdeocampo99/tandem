import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "../../coordinator/record.ts";
import { COPY_ASSET_TOOL, SUBMIT_REPORT_TOOL } from "../../workers/terminal.ts";
import type {
  AgentKind,
  AgentProcess,
  Harness,
  LaunchSpec,
  UnrecordedCoordinatorMatch,
} from "../contract.ts";
import { listOmpMcpServers, listOmpModels, validateModel } from "./adapter.ts";

const OMP_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const COORDINATOR_EXTENSION_PATH = join(OMP_DIRECTORY, "extension.ts");
const WORKER_EXTENSION_PATH = join(OMP_DIRECTORY, "worker-control.ts");
const CONFIG_PATH = join(OMP_DIRECTORY, "worker-config.yml");
/** Coordinators launched before the OMP code moved under harness/omp/ still name this path. */
const PRE_HARNESS_COORDINATOR_EXTENSION_PATH = join(OMP_DIRECTORY, "..", "..", "extension.ts");

// write, edit, and copy_asset reach only the mockup folder Tandem names (see mockupWriteDecision).
// The pr-reviewer's bash is limited to read-only git and gh commands by the worker extension.
// The coordinator gets no grep or glob: searching the repository is a scout's job.
const TOOLS: Readonly<Record<AgentKind, readonly string[]>> = {
  coordinator: ["read", "ask", "tandem"],
  scout: [
    "read",
    "grep",
    "glob",
    "web_search",
    "task",
    "write",
    "edit",
    COPY_ASSET_TOOL,
    SUBMIT_REPORT_TOOL,
  ],
  reviewer: ["read", "grep", "glob", SUBMIT_REPORT_TOOL],
  "pr-reviewer": ["read", "grep", "glob", SUBMIT_REPORT_TOOL, "bash"],
  implementer: ["read", "grep", "glob", "edit", "write", "bash", "todo", SUBMIT_REPORT_TOOL],
  presentation: ["read", "grep", "glob", "write", "edit", SUBMIT_REPORT_TOOL],
};

type CommandOption = Readonly<{
  readonly present: boolean;
  readonly value: string | undefined;
}>;

function commandOption(argv: readonly string[], option: string): CommandOption {
  let value: string | undefined;
  let present = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue;
    if (present || index + 1 >= argv.length || argv[index + 1]?.startsWith("--") === true) {
      return { present: true, value: undefined };
    }
    present = true;
    value = argv[index + 1];
    index += 1;
  }
  return { present, value };
}

function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return (slash === -1 ? value : value.slice(slash + 1)).replace(/^-/, "").toLowerCase();
}

function launcherIndex(argv: readonly string[]): number | undefined {
  if (basename(argv[0] ?? "") === "omp") return 0;
  if (basename(argv[0] ?? "") !== "bun") return undefined;
  if (basename(argv[1] ?? "") === "omp") return 1;
  if (basename(argv[1] ?? "") === "bun" && basename(argv[2] ?? "") === "omp") return 2;
  return undefined;
}

/** `--continue` only resumes the saved conversation, so it never distinguishes one coordinator. */
function normalizedCommand(argv: readonly string[]): readonly string[] | undefined {
  const index = launcherIndex(argv);
  return index === undefined
    ? undefined
    : ["omp", ...argv.slice(index + 1).filter((value) => value !== "--continue")];
}

function modelFlags(spec: LaunchSpec): readonly string[] {
  return spec.model === undefined
    ? []
    : ["--model", spec.model.model, "--thinking", spec.model.thinking];
}

function promptArgument(spec: LaunchSpec): readonly string[] {
  return spec.prompt === undefined ? [] : [spec.prompt];
}

function coordinatorCommand(spec: LaunchSpec): readonly string[] {
  const conversation = spec.conversation;
  return [
    "omp",
    ...modelFlags(spec),
    "--config",
    CONFIG_PATH,
    "--no-extensions",
    "--extension",
    COORDINATOR_EXTENSION_PATH,
    "--tools",
    TOOLS.coordinator.join(","),
    "--cwd",
    spec.cwd,
    "--no-prewalk",
    "--no-title",
    ...(conversation.kind === "saved" && conversation.resume ? ["--continue"] : []),
    ...(conversation.kind === "saved" && conversation.directory !== undefined
      ? ["--session-dir", conversation.directory]
      : []),
    ...promptArgument(spec),
  ];
}

function workerCommand(spec: LaunchSpec): readonly string[] {
  const conversation = spec.conversation;
  return [
    "omp",
    ...modelFlags(spec),
    "--no-prewalk",
    "--no-rules",
    "--no-title",
    "--no-extensions",
    "--extension",
    WORKER_EXTENSION_PATH,
    ...(conversation.kind === "none"
      ? ["--no-session"]
      : [
          ...(conversation.directory === undefined
            ? []
            : ["--session-dir", conversation.directory]),
          ...(conversation.resume ? ["--continue"] : []),
        ]),
    "--config",
    CONFIG_PATH,
    "--cwd",
    spec.cwd,
    "--tools",
    TOOLS[spec.agent].join(","),
    ...promptArgument(spec),
  ];
}

function sameCommand(live: readonly string[], recorded: readonly string[]): boolean {
  const normalizedLive = normalizedCommand(live);
  const normalizedRecorded = normalizedCommand(recorded);
  return (
    normalizedLive !== undefined &&
    normalizedRecorded !== undefined &&
    normalizedLive.length === normalizedRecorded.length &&
    normalizedLive.every((value, index) => value === normalizedRecorded[index])
  );
}

function looksLikeAgent(process: AgentProcess): boolean {
  return (
    normalizedCommand(process.argv) !== undefined ||
    [process.name, process.argv0]
      .filter((value): value is string => value !== undefined)
      .some((value) => basename(value) === "omp")
  );
}

/**
 * Proves an OMP process is a Tandem coordinator for this repository: it loads Tandem's coordinator
 * extension from either location and runs in the repository or its legacy session directory.
 */
async function matchUnrecordedCoordinator(
  argv: readonly string[],
  expected: Readonly<{ repoPath: string; sessionDirectory: string }>,
): Promise<UnrecordedCoordinatorMatch> {
  const normalized = normalizedCommand(argv);
  if (normalized === undefined) return "unknown";
  const extension = commandOption(normalized, "--extension");
  if (!extension.present) return "no-match";
  if (extension.value === undefined) return "unknown";
  const coordinatorExtensions = await Promise.all(
    [COORDINATOR_EXTENSION_PATH, PRE_HARNESS_COORDINATOR_EXTENSION_PATH].map((path) =>
      canonicalPath(path, "coordinator extension"),
    ),
  );
  const actualExtension = await canonicalPath(extension.value, "coordinator extension");
  if (!coordinatorExtensions.includes(actualExtension)) return "no-match";

  const cwd = commandOption(normalized, "--cwd");
  const session = commandOption(normalized, "--session-dir");
  if (
    (cwd.present && cwd.value === undefined) ||
    (session.present && session.value === undefined)
  ) {
    return "unknown";
  }
  if (!cwd.present && !session.present) return "no-match";
  if (
    cwd.value !== undefined &&
    (await canonicalPath(cwd.value, "coordinator cwd")) === expected.repoPath
  ) {
    return "match";
  }
  if (
    session.value !== undefined &&
    (await canonicalPath(session.value, "coordinator session directory")) ===
      expected.sessionDirectory
  ) {
    return "match";
  }
  return "no-match";
}

function processNeedle(recorded: readonly string[]): string | undefined {
  const sessionDirectory = commandOption(recorded, "--session-dir").value;
  return sessionDirectory === undefined ? undefined : `--session-dir ${sessionDirectory}`;
}

export const ompHarness: Harness = {
  executable: "omp",
  coordinatorFiles: [
    { name: "extension", path: COORDINATOR_EXTENSION_PATH, kind: "file" },
    { name: "config", path: CONFIG_PATH, kind: "file" },
  ],
  launchEnvironment: {},
  // OMP finds a saved conversation by its directory and loads Tandem before it reads input.
  coordinatorConversation: async ({ directory, resume }) => ({ kind: "saved", directory, resume }),
  awaitCoordinatorReady: async () => undefined,
  command: (spec) =>
    spec.agent === "coordinator" ? coordinatorCommand(spec) : workerCommand(spec),
  sameCommand,
  looksLikeAgent,
  matchUnrecordedCoordinator,
  processNeedle,
  listModels: (run, cwd) => listOmpModels(run, { cwd }),
  validateModel: (run, cwd, model) => validateModel(run, { cwd, model }),
  listMcpServers: listOmpMcpServers,
};
