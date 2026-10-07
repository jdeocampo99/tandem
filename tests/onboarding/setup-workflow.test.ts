import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import type { ClaudeCodeAvailability } from "../../src/harness/claude-code/availability.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import type { SetupAnswer } from "../../src/onboarding/setup-answer.ts";
import {
  SetupWorkflow,
  type SetupWorkflowDependencies,
} from "../../src/onboarding/setup-workflow.ts";
import { findCheckoutsByName } from "../../src/repos/locate.ts";

const catalogue: readonly ModelRecord[] = [
  {
    selector: "anthropic/opus",
    id: "opus",
    provider: "anthropic",
    name: "Opus",
    thinking: ["high"],
  },
];

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function done(stdout = "", code = 0): CommandResult {
  return { code, stdout, stderr: "" };
}

/** A machine with a code folder holding `api` (new) and `old` (already set up). */
async function machine(
  options: Readonly<{
    fail?: (code: string) => ReadonlySet<string>;
    outsideRepo?: boolean;
    savedRoots?: (code: string) => string[];
    availableModels?: readonly ModelRecord[];
    claudeCode?: ClaudeCodeAvailability;
  }> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-setup-")));
  roots.push(root);
  const home = join(root, "home");
  const code = join(root, "code");
  const outside = join(root, "elsewhere", "my-app");
  for (const repo of ["api", "old", "api/src"]) await mkdir(join(code, repo), { recursive: true });
  for (const repo of ["api", "old"]) await mkdir(join(code, repo, ".git"));
  if (options.outsideRepo) await mkdir(join(outside, ".git"), { recursive: true });
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    const [command, , second, third] = request.argv;
    if (command === "git" && third === "rev-parse") {
      const dir = second ?? "";
      if (dir === outside && options.outsideRepo) return done(`${outside}\n`);
      const top = dir.startsWith(join(code, "api")) ? join(code, "api") : join(code, "old");
      return dir.startsWith(code) ? done(`${top}\n`) : done("", 128);
    }
    return done("", 1);
  };
  const saved: string[] = [];
  let settings: HomeSettings = {
    selfImprovement: "off",
    selfImprovementChosen: false,
    projectRoots: options.savedRoots?.(code) ?? [],
  };
  const fail = options.fail?.(code) ?? new Set<string>();
  const record = (name: string) => async () => {
    saved.push(name);
    if (fail.has(name)) throw new Error(`${name} broke`);
  };
  const deps: SetupWorkflowDependencies = {
    homeFolder: root,
    run,
    clock: () => "2026-09-26T12:00:00.000Z",
    models: async () => ({
      availableModels: options.availableModels ?? catalogue,
      modelSettings: {
        configPath: join(home, "models.json"),
        configured: false,
        enabledProviders: [],
        jev: "off",
      },
      claudeCode: options.claudeCode ?? "ready",
    }),
    roots: async () => [code, join(root, "missing")],
    homeSettings: async () => settings,
    registeredProjects: async () => [join(code, "old")],
    inspectRepo: async () => ({
      validationCommands: ["bun run test"],
      noChecks: false,
      discoveredCommands: ["bun run test"],
      sources: ["package.json scripts"],
      setupCommands: ["bun install --frozen-lockfile"],
      lockfile: "bun.lock",
    }),
    saveModels: async (input) => {
      saved.push(`models ${input.enabledProviders.join(",")}`);
    },
    saveSelfImprovement: async (mode) => record(`mode ${mode}`)(),
    saveCodeFolders: async (folders) => {
      await record(`folders ${folders.join(",")}`)();
      settings = { ...settings, projectRoots: folders };
    },
    setupRepo: async (path, repo) =>
      record(
        `setup ${path} ${JSON.stringify([repo.validationCommands, repo.setupCommands])}${repo.noChecks ? " no-checks" : ""}`,
      )(),
    updateRepoCommands: async (path, commands) =>
      record(
        `update ${path} ${JSON.stringify([commands.validationCommands, commands.setupCommands])}${commands.noChecks ? " no-checks" : ""}`,
      )(),
    openProject: async (path) => record(`open ${path}`)(),
  };
  return {
    workflow: new SetupWorkflow(deps),
    saved,
    code,
    outside,
    find: (name: string) => findCheckoutsByName(name, settings.projectRoots, run),
  };
}

function answerOf(
  repositories: SetupAnswer["repositories"],
  mode: SetupAnswer["mode"] = "settings",
  scoutModel = "anthropic/opus",
): SetupAnswer {
  const pick = (model: string) => ({ model, thinking: "high" as const });
  return {
    mode,
    models: {
      coordinator: pick("anthropic/opus"),
      scout: pick(scoutModel),
      implementer: pick("anthropic/opus"),
      reviewer: pick("anthropic/opus"),
      presentation: pick("anthropic/opus"),
    },
    repositories,
    selfImprovement: "fix",
  };
}

test("the view inspects every discovered checkout and splits those set up from those to add", async () => {
  const { workflow, code } = await machine();
  const view = await workflow.view("/tandem", "settings");
  expect(view.mode).toBe("settings");
  expect(view.repos.map((repo) => repo.path)).toEqual([join(code, "old")]);
  expect(view.candidates.map((repo) => repo.path)).toEqual([join(code, "api")]);
  expect(view.repos[0]?.validationCommands).toEqual(["bun run test"]);
  expect(view.candidates[0]?.setupCommands).toEqual(["bun install --frozen-lockfile"]);
});

test("a valid answer is saved in order", async () => {
  const { workflow, saved, code } = await machine();
  const report = await workflow.apply(
    "/tandem",
    answerOf(
      [{ path: join(code, "api"), validationCommands: ["make check"], setupCommands: [] }],
      "setup",
    ),
  );
  expect(saved).toEqual([
    "models anthropic",
    "mode fix",
    `folders ${code}`,
    `setup ${join(code, "api")} [["make check"],[]]`,
    `open ${join(code, "api")}`,
  ]);
  expect(report.complete).toBe(true);
  expect(report.message).toContain(`api (${join(code, "api")}): its chat is open.`);
});

test("approved mixed-model choices enable only the providers used by those models", async () => {
  const availableModels: readonly ModelRecord[] = [
    ...catalogue,
    { selector: "openai/gpt", id: "gpt", provider: "openai", thinking: ["high"] },
    { selector: "google/gemini", id: "gemini", provider: "google", thinking: ["high"] },
  ];
  const { workflow, saved } = await machine({ availableModels });
  await workflow.apply("/tandem", answerOf([], "settings", "openai/gpt"));
  expect(saved[0]).toBe("models anthropic,openai");
});

test("a Claude Code role is saved without enabling Claude Code for spending", async () => {
  const { workflow, saved } = await machine();
  await workflow.apply("/tandem", answerOf([], "settings", "claude-code/sonnet"));
  expect(saved[0]).toBe("models anthropic");
});

test("a Claude Code role is refused when Claude Code isn't installed", async () => {
  const { workflow, saved } = await machine({ claudeCode: "not-installed" });
  await expect(
    workflow.apply("/tandem", answerOf([], "settings", "claude-code/sonnet")),
  ).rejects.toThrow("Research: claude-code/sonnet isn't available on this computer.");
  expect(saved).toEqual([]);
});

test("a pasted repo outside the scanned folders makes its parent searchable after saving", async () => {
  const { workflow, find, outside } = await machine({ outsideRepo: true });
  await workflow.apply(
    "/tandem",
    answerOf([{ path: outside, validationCommands: ["make check"] }], "setup"),
  );
  expect(await find("my-app")).toEqual([{ path: outside }]);
});

test("saved code folders are left alone", async () => {
  const { workflow, saved } = await machine({ savedRoots: (code) => [code] });
  await workflow.apply("/tandem", answerOf([]));
  expect(saved.filter((entry) => entry.startsWith("folders "))).toEqual([]);
});

test("a failed step is reported without undoing the others, and its chat is not opened", async () => {
  const { workflow, saved, code } = await machine({
    fail: (code) => new Set([`mode fix`, `setup ${join(code, "api")} [["make check"],null]`]),
  });
  const report = await workflow.apply(
    "/tandem",
    answerOf([{ path: join(code, "api"), validationCommands: ["make check"] }], "setup"),
  );
  expect(report.complete).toBe(false);
  expect(report.opened).toEqual([]);
  expect(report.message).toContain("The issue setting was not saved: mode fix broke");
  expect(report.message).toContain(`api (${join(code, "api")}): not set up:`);
  expect(saved.some((entry) => entry.startsWith("open "))).toBe(false);
  expect(saved[0]).toBe("models anthropic");
});

test("an answer that can't be saved is refused with every problem and saves nothing", async () => {
  const { workflow, code, saved } = await machine();
  await expect(
    workflow.apply(
      "/tandem",
      answerOf(
        [
          { path: join(code, "api"), validationCommands: [" "] },
          { path: join(code, "api", "src"), validationCommands: ["make check"] },
        ],
        "setup",
      ),
    ),
  ).rejects.toThrow(
    `The setup answer can't be saved: api needs a validation command, or choose No checks. ${join(code, "api", "src")} is inside the repository at ${join(code, "api")}; add that folder.`,
  );
  expect(saved).toEqual([]);
});

test("a repository without a validation command names itself, even when it is already set up", async () => {
  const { workflow, code, saved } = await machine();
  await expect(
    workflow.apply("/tandem", answerOf([{ path: join(code, "old"), validationCommands: [] }])),
  ).rejects.toThrow(
    "The setup answer can't be saved: old needs a validation command, or choose No checks.",
  );
  expect(saved).toEqual([]);
});

test("settings saves an edited repository's commands in place and opens no chat for it", async () => {
  const { workflow, saved, code } = await machine();
  const report = await workflow.apply(
    "/tandem",
    answerOf([
      { path: join(code, "old"), validationCommands: ["make check"], setupCommands: ["make deps"] },
      { path: join(code, "api"), validationCommands: ["make check"] },
    ]),
  );
  expect(saved.slice(2)).toEqual([
    `folders ${code}`,
    `update ${join(code, "old")} [["make check"],["make deps"]]`,
    `setup ${join(code, "api")} [["make check"],null]`,
    `open ${join(code, "api")}`,
  ]);
  expect(report.opened).toEqual(["api"]);
});

test("a repository saved with no checks keeps that choice, new or already set up", async () => {
  const { workflow, saved, code } = await machine();
  await workflow.apply(
    "/tandem",
    answerOf([
      { path: join(code, "old"), validationCommands: [], noChecks: true },
      { path: join(code, "api"), validationCommands: [], noChecks: true },
    ]),
  );
  expect(saved.slice(2)).toEqual([
    `folders ${code}`,
    `update ${join(code, "old")} [[],null] no-checks`,
    `setup ${join(code, "api")} [[],null] no-checks`,
    `open ${join(code, "api")}`,
  ]);
});

test("setup opens the chat of a repository that was already set up", async () => {
  const { workflow, saved, code } = await machine();
  const report = await workflow.apply(
    "/tandem",
    answerOf([{ path: join(code, "old"), validationCommands: ["make check"] }], "setup"),
  );
  expect(saved.slice(3)).toEqual([
    `update ${join(code, "old")} [["make check"],null]`,
    `open ${join(code, "old")}`,
  ]);
  expect(report.opened).toEqual(["old"]);
});
