import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseConversation,
  claudeCodeHarness,
  parseConversationPointer,
} from "../../../src/harness/claude-code/launch.ts";
import { sidecarSocketPath } from "../../../src/harness/claude-code/socket.ts";
import type {
  CoordinatorLaunchIo,
  LaunchSpec,
  SavedConversation,
} from "../../../src/harness/contract.ts";

const PLUGINS = fileURLToPath(
  new URL("../../../src/harness/claude-code/plugins/", import.meta.url),
);
const ADAPTER = join(PLUGINS, "tandem");
const RENDERER = join(PLUGINS, "tandem-renderer");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DIRECTORY = "/home/coordinator-sessions/abc";
const POINTER = join(DIRECTORY, "claude-code-conversation");

function coordinatorSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    agent: "coordinator",
    cwd: "/pool/coordinator",
    model: { model: "claude-code/opus", thinking: "high" },
    conversation: { kind: "saved", directory: DIRECTORY, resume: false, id: ID },
    ...overrides,
  };
}

const FLAGS = [
  "--setting-sources",
  "project,local",
  "--strict-mcp-config",
  "--no-chrome",
  "--disable-slash-commands",
  "--system-prompt-snapshot",
  "off",
  "--tools",
  "Read,AskUserQuestion",
];

type FakeIo = CoordinatorLaunchIo & {
  readonly reads: string[];
  readonly writes: Array<readonly [string, string]>;
  readonly probes: string[];
};

function fakeIo(
  options: Readonly<{
    files?: Readonly<Record<string, string>>;
    healthyAfter?: number;
    onSleep?: () => void;
  }> = {},
): FakeIo {
  let clock = 0;
  const reads: string[] = [];
  const writes: Array<readonly [string, string]> = [];
  const probes: string[] = [];
  return {
    reads,
    writes,
    probes,
    readText: async (path) => {
      reads.push(path);
      return options.files?.[path];
    },
    writeText: async (path, text) => {
      writes.push([path, text]);
    },
    newId: () => OTHER_ID,
    answersHealth: async (socket) => {
      probes.push(socket);
      return options.healthyAfter !== undefined && probes.length > options.healthyAfter;
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
      options.onSleep?.();
    },
    now: () => clock,
  };
}

test("a fresh coordinator names its new conversation and runs only Tandem's plugins and tools", () => {
  expect(claudeCodeHarness.command(coordinatorSpec({ prompt: "hello" }))).toEqual([
    "claude",
    "--plugin-dir",
    ADAPTER,
    "--plugin-dir",
    RENDERER,
    "--session-id",
    ID,
    "--model",
    "opus",
    "--effort",
    "high",
    ...FLAGS,
    "hello",
  ]);
});

test("a resumed coordinator continues the same conversation", () => {
  const argv = claudeCodeHarness.command(
    coordinatorSpec({
      conversation: { kind: "saved", directory: DIRECTORY, resume: true, id: ID },
    }),
  );
  expect(argv.slice(5, 7)).toEqual(["--resume", ID]);
  expect(argv).not.toContain("--session-id");
});

test("Haiku runs without --effort", () => {
  const argv = claudeCodeHarness.command(
    coordinatorSpec({ model: { model: "claude-code/haiku", thinking: "off" } }),
  );
  expect(argv.slice(7, 10)).toEqual(["--model", "haiku", "--setting-sources"]);
  expect(argv).not.toContain("--effort");
});

test("a coordinator command needs a conversation id, and workers are refused", () => {
  expect(() =>
    claudeCodeHarness.command(
      coordinatorSpec({ conversation: { kind: "saved", directory: DIRECTORY, resume: false } }),
    ),
  ).toThrow("a Claude Code coordinator needs a saved conversation id");
  expect(() => claudeCodeHarness.command(coordinatorSpec({ agent: "scout" }))).toThrow(
    "Tandem runs only the coordinator in Claude Code so far, not a scout.",
  );
});

test("resuming continues the recorded conversation; anything else starts a new one", () => {
  const newId = () => OTHER_ID;
  expect(chooseConversation(ID, true, newId)).toEqual({ id: ID, resume: true });
  expect(chooseConversation(undefined, true, newId)).toEqual({ id: OTHER_ID, resume: false });
  expect(chooseConversation(ID, false, newId)).toEqual({ id: OTHER_ID, resume: false });
});

test("a pointer holding anything but a conversation id fails closed with a way out", () => {
  expect(parseConversationPointer(`${ID}\n`, POINTER)).toBe(ID);
  expect(() => parseConversationPointer("not-an-id\n", POINTER)).toThrow(
    `${POINTER} does not hold a Claude Code conversation id, so Tandem can't tell which conversation to continue. Run \`tandem --fresh\` to start a new one.`,
  );
});

test("a launch reads the pointer only to resume, and starts fresh when there is none", async () => {
  const recorded = fakeIo({ files: { [POINTER]: `${ID}\n` } });
  expect(
    await claudeCodeHarness.coordinatorConversation(
      { home: "/home", directory: DIRECTORY, resume: true },
      recorded,
    ),
  ).toEqual({
    kind: "saved",
    directory: DIRECTORY,
    resume: true,
    id: ID,
  });

  const fresh = fakeIo({ files: { [POINTER]: `${ID}\n` } });
  expect(
    await claudeCodeHarness.coordinatorConversation(
      { home: "/home", directory: DIRECTORY, resume: false },
      fresh,
    ),
  ).toEqual({
    kind: "saved",
    directory: DIRECTORY,
    resume: false,
    id: OTHER_ID,
  });
  expect(fresh.reads).toEqual([]);

  const missing = fakeIo();
  expect(
    await claudeCodeHarness.coordinatorConversation(
      { home: "/home", directory: DIRECTORY, resume: true },
      missing,
    ),
  ).toMatchObject({
    resume: false,
    id: OTHER_ID,
  });
  expect(missing.writes).toEqual([]);
});

test("a home too long for the sidecar's socket is refused before the coordinator starts", async () => {
  await expect(
    claudeCodeHarness.coordinatorConversation(
      { home: `/${"h".repeat(100)}`, directory: DIRECTORY, resume: false },
      fakeIo(),
    ),
  ).rejects.toThrow("use a shorter Tandem home");
});

const STARTED = {
  home: "/home",
  repo: "/repo",
  conversation: {
    kind: "saved",
    directory: DIRECTORY,
    resume: false,
    id: ID,
  } satisfies SavedConversation,
};

test("the coordinator is ready once its sidecar answers, and only then is its conversation kept", async () => {
  const io = fakeIo({ healthyAfter: 2 });
  await claudeCodeHarness.awaitCoordinatorReady(STARTED, io);
  expect(io.probes).toEqual(Array(3).fill(sidecarSocketPath("/home", ID)));
  expect(io.writes).toEqual([[POINTER, `${ID}\n`]]);
});

test("a coordinator that never loads Tandem's plugin fails in plain English after 30 seconds", async () => {
  const io = fakeIo();
  await expect(claudeCodeHarness.awaitCoordinatorReady(STARTED, io)).rejects.toThrow(
    `Claude Code started but did not load Tandem's plugin within 30 seconds, so Tandem stopped this coordinator. Usually Claude Code is asking whether to trust the project, or its mods are switched off. To trust the project, run \`claude\` once in /repo and choose "Yes, I trust this folder"; Tandem's worktrees of the project are then trusted too. If mods are switched off, check that no Claude Code settings file sets \`disableAllHooks\`. Then run \`tandem\` again.`,
  );
  expect(io.probes).toHaveLength(121);
  expect(io.writes).toEqual([]);
});

test("an abandoned ready wait resolves without keeping the conversation", async () => {
  const stop = new AbortController();
  const io = fakeIo({ onSleep: () => stop.abort() });
  await claudeCodeHarness.awaitCoordinatorReady(STARTED, io, stop.signal);
  expect(io.probes).toHaveLength(1);
  expect(io.writes).toEqual([]);
});

test("--session-id and --resume of one conversation are the same coordinator", () => {
  const fresh = claudeCodeHarness.command(coordinatorSpec({ prompt: "hello" }));
  const resumed = fresh.map((value) => (value === "--session-id" ? "--resume" : value));
  expect(claudeCodeHarness.sameCommand(resumed, fresh)).toBe(true);
  expect(claudeCodeHarness.sameCommand(["/opt/bin/claude", ...fresh.slice(1)], fresh)).toBe(true);
  expect(claudeCodeHarness.processNeedle(fresh)).toBe(ID);
});

test("commands that differ, or that name no single conversation, never match", () => {
  const recorded = claudeCodeHarness.command(coordinatorSpec());
  const differentId = recorded.map((value) => (value === ID ? OTHER_ID : value));
  const differentModel = recorded.map((value) => (value === "opus" ? "sonnet" : value));
  const both = [...recorded, "--resume", ID];
  const noId = recorded.filter((value) => value !== "--session-id" && value !== ID);
  const missingValue = [...recorded.slice(0, 5), "--session-id", "--model", "opus"];
  const duplicateFlag = [...recorded, "--model", "opus"];
  for (const live of [differentId, differentModel, both, noId, missingValue, duplicateFlag]) {
    expect(claudeCodeHarness.sameCommand(live, recorded)).toBe(false);
    expect(claudeCodeHarness.sameCommand(recorded, live)).toBe(false);
  }
  expect(claudeCodeHarness.sameCommand(duplicateFlag, duplicateFlag)).toBe(false);
  expect(claudeCodeHarness.sameCommand(["omp", ...recorded.slice(1)], recorded)).toBe(false);
  expect(claudeCodeHarness.processNeedle(noId)).toBeUndefined();
  expect(claudeCodeHarness.processNeedle(both)).toBeUndefined();
});

test("a claude process looks like an agent by its argv[0], whatever binary runs it", () => {
  const looks = (argv: readonly string[], name: string) =>
    claudeCodeHarness.looksLikeAgent({ name, argv, argv0: undefined });
  expect(looks(["claude", "--resume", ID], "2.1.288")).toBe(true);
  expect(looks(["/Users/me/.local/bin/claude"], "2.1.288")).toBe(true);
  expect(looks(["omp"], "omp")).toBe(false);
  expect(looks(["-zsh"], "zsh")).toBe(false);
});

test("an unrecorded claude process loading Tandem's plugin can't be proven either way", async () => {
  const expected = { repoPath: "/repo", sessionDirectory: DIRECTORY };
  const match = (argv: readonly string[]) =>
    claudeCodeHarness.matchUnrecordedCoordinator(argv, expected);
  expect(await match(claudeCodeHarness.command(coordinatorSpec()))).toBe("unknown");
  expect(await match(["claude", "--plugin-dir", "/elsewhere/plugin", "--resume", ID])).toBe(
    "no-match",
  );
  expect(await match(["claude"])).toBe("no-match");
  expect(await match(["claude", "--plugin-dir"])).toBe("unknown");
  expect(await match(["node", "cli.js"])).toBe("unknown");
});

test("models come from the fixed catalogue and there are no MCP servers", async () => {
  const run = async () => {
    throw new Error("Claude Code models are never listed by running a command");
  };
  expect((await claudeCodeHarness.listModels(run, "/repo")).map((model) => model.selector)).toEqual(
    ["claude-code/fable", "claude-code/opus", "claude-code/sonnet", "claude-code/haiku"],
  );
  expect(
    (
      await claudeCodeHarness.validateModel(run, "/repo", {
        model: "claude-code/opus",
        thinking: "max",
      })
    ).selector,
  ).toBe("claude-code/opus");
  await expect(
    claudeCodeHarness.validateModel(run, "/repo", { model: "claude-code/haiku", thinking: "high" }),
  ).rejects.toThrow('selector "claude-code/haiku" does not support thinking "high"');
  await expect(
    claudeCodeHarness.validateModel(run, "/repo", { model: "claude-code/gpt", thinking: "high" }),
  ).rejects.toThrow("is not one of Claude Code's models");
  expect(await claudeCodeHarness.listMcpServers("/repo")).toEqual([]);
});

test("the coordinator loads both plugin directories and keeps mods on", () => {
  expect(claudeCodeHarness.coordinatorFiles).toEqual([
    { name: "adapter plugin", path: ADAPTER, kind: "directory" },
    { name: "renderer plugin", path: RENDERER, kind: "directory" },
  ]);
  expect(claudeCodeHarness.launchEnvironment).toEqual({ DISABLE_GROWTHBOOK: "1" });
});
