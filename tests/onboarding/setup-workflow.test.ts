import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import type { ClaudeCodeAvailability } from "../../src/harness/claude-code/availability.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import type { SetupAnswer } from "../../src/onboarding/setup-answer.ts";
import type { SetupView } from "../../src/onboarding/setup-view.ts";
import {
  SetupWorkflow,
  type SetupWorkflowDependencies,
} from "../../src/onboarding/setup-workflow.ts";
import { findCheckoutsByName } from "../../src/repos/locate.ts";
import type { CreateTaskRequest, TandemService } from "../../src/service/controller.ts";
import { executeTandemAction, type TandemAction } from "../../src/session/actions.ts";
import { changeHomeSpecialist, type SpecialistChange } from "../../src/specialists/home-files.ts";
import { loadSpecialists, specialistFileRevision } from "../../src/specialists/registry.ts";
import { task } from "../session/fixtures.ts";

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
    /** `old` has a GitHub remote, acme/old. */
    remotes?: boolean;
    /** Tern: Settings can open natively, so a chat draft goes there instead of to a file. */
    tern?: boolean;
    /** Why Settings can't open for the project yet. */
    refusal?: string;
  }> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-setup-")));
  roots.push(root);
  const home = join(root, "home");
  const tandemHome = join(root, "tandem-home");
  await mkdir(tandemHome);
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
    if (
      command === "git" &&
      third === "remote" &&
      options.remotes &&
      second === join(code, "old")
    ) {
      return done("git@github.com:acme/old.git\n");
    }
    return done("", 1);
  };
  const saved: string[] = [];
  const created: CreateTaskRequest[] = [];
  const opened: SetupView[] = [];
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
      scriptCommands: ["bun run test"],
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
      record(`setup ${path} ${JSON.stringify([repo.validationCommands, repo.setupCommands])}`)(),
    updateRepoCommands: async (path, commands) =>
      record(
        `update ${path} ${JSON.stringify([commands.validationCommands, commands.setupCommands])}`,
      )(),
    openProject: async (path) => record(`open ${path}`)(),
    specialists: (repoPath) => loadSpecialists({ repositoryCheckout: repoPath, tandemHome }),
    changeSpecialist: async (change) => {
      saved.push(`specialist ${change.op} ${change.name}`);
      return changeHomeSpecialist(tandemHome, change);
    },
    createTask: async (input) => {
      created.push(input);
      return task({ id: `task-${created.length}`, repoPath: input.repoPath });
    },
    settingsRefusal: async () => options.refusal,
    ...(options.tern === true
      ? {
          openSettings: async (_repoPath: string, view: SetupView) => {
            opened.push(view);
          },
        }
      : {}),
  };
  return {
    workflow: new SetupWorkflow(deps),
    saved,
    created,
    opened,
    code,
    outside,
    find: (name: string) => findCheckoutsByName(name, settings.projectRoots, run),
    tandemHome,
  };
}

function answerOf(
  repositories: SetupAnswer["repositories"],
  mode: SetupAnswer["mode"] = "settings",
  scoutModel = "anthropic/opus",
  specialists: readonly SpecialistChange[] = [],
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
    specialists,
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
    `The setup answer can't be saved: api needs a validation command. ${join(code, "api", "src")} is inside the repository at ${join(code, "api")}; add that folder.`,
  );
  expect(saved).toEqual([]);
});

test("a repository without a validation command names itself, even when it is already set up", async () => {
  const { workflow, code, saved } = await machine();
  await expect(
    workflow.apply("/tandem", answerOf([{ path: join(code, "old"), validationCommands: [] }])),
  ).rejects.toThrow("The setup answer can't be saved: old needs a validation command.");
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

const NOTES = { label: "Notes", instructions: "Keep it short.", steps: ["Draft"] };

test("Settings shows the project's specialists; first-time setup does not", async () => {
  const { workflow, tandemHome } = await machine();
  await changeHomeSpecialist(tandemHome, { op: "create", name: "notes", fields: NOTES });
  const settings = await workflow.view("/tandem", "settings");
  expect(settings.specialists?.project).toBe("tandem");
  expect(settings.specialists?.rows.find((row) => row.origin === "home")).toMatchObject({
    name: "notes",
    state: "ready",
    summary: "Only when named",
  });
  expect((await workflow.view("/tandem", "setup")).specialists).toBeUndefined();
});

test("each specialist change is one step after the rest of the settings", async () => {
  const { workflow, saved, code, tandemHome } = await machine();
  const old = await changeHomeSpecialist(tandemHome, { op: "create", name: "old", fields: NOTES });
  const revision = specialistFileRevision(await readFile(old.path));
  const report = await workflow.apply(
    "/tandem",
    answerOf([], "settings", "anthropic/opus", [
      { op: "create", name: "notes", fields: NOTES },
      { op: "remove", name: "old", revision },
    ]),
  );
  expect(saved).toEqual([
    "models anthropic",
    "mode fix",
    `folders ${code}`,
    "specialist create notes",
    "specialist remove old",
  ]);
  expect(report.complete).toBe(true);
  expect(report.message).toContain("Saved your specialist notes.");
  expect(report.message).toContain("Removed your specialist old.");
  expect(await readdir(join(tandemHome, "specialists"))).toEqual(["notes.md"]);
});

test("one specialist change that can't be saved refuses the whole answer and writes nothing", async () => {
  const { workflow, saved, tandemHome } = await machine();
  const kept = await changeHomeSpecialist(tandemHome, {
    op: "create",
    name: "kept",
    fields: NOTES,
  });
  const shown = specialistFileRevision(await readFile(kept.path));
  await writeFile(kept.path, "---\nname: kept\n---\nEdited by hand.\n");
  await expect(
    workflow.apply(
      "/tandem",
      answerOf([], "settings", "anthropic/opus", [
        { op: "create", name: "fresh", fields: NOTES },
        { op: "update", name: "kept", revision: shown, fields: NOTES },
      ]),
    ),
  ).rejects.toThrow("kept changed on disk since Settings showed it. Reopen Settings.");
  expect(saved).toEqual([]);
  expect(await readdir(join(tandemHome, "specialists"))).toEqual(["kept.md"]);
  expect(await readFile(kept.path, "utf8")).toContain("Edited by hand.");
});

test("sharing starts one implementation task carrying the file byte for byte, pinned to general", async () => {
  const { workflow, created, code, tandemHome } = await machine({ remotes: true });
  const project = join(code, "api");
  const notes = await changeHomeSpecialist(tandemHome, {
    op: "create",
    name: "notes",
    fields: { ...NOTES, instructions: "Fence code:\n\n```ts\nx\n```" },
  });
  const text = await readFile(notes.path, "utf8");
  const revision = specialistFileRevision(await readFile(notes.path));

  await workflow.shareSpecialist(project, { name: "notes", revision, target: project });
  await workflow.shareSpecialist(project, { name: "notes", revision, target: join(code, "old") });

  const [own, other] = created;
  expect(own).toMatchObject({
    repoPath: project,
    kind: "implementation",
    title: "share notes specialist",
    specialist: "general",
    surfaces: [".tandem/specialists/notes.md"],
    acceptanceCriteria: [
      "`.tandem/specialists/notes.md` has exactly the content in the objective",
      "No other file changes",
      "`tandem specialists` lists notes from the repository with no problems",
    ],
  });
  // The fence is longer than any backtick run in the file, so the file sits in it whole.
  expect(own?.objective).toContain(`\n\`\`\`\`markdown\n${text}\`\`\`\``);
  expect(own?.requestId).toBeUndefined();
  expect(own?.targetRepo).toBeUndefined();
  expect(other).toMatchObject({
    repoPath: project,
    targetRepo: "acme/old",
    targetCheckout: join(code, "old"),
  });
});

test("sharing refuses a changed file, a repository Tandem doesn't work in, and one without GitHub", async () => {
  const { workflow, created, code, outside, tandemHome } = await machine();
  const project = join(code, "api");
  const notes = await changeHomeSpecialist(tandemHome, {
    op: "create",
    name: "notes",
    fields: NOTES,
  });
  const shown = specialistFileRevision(await readFile(notes.path));
  await writeFile(notes.path, "---\nname: notes\nlabel: Notes\n---\nEdited by hand.\n");
  await expect(
    workflow.shareSpecialist(project, { name: "notes", revision: shown, target: project }),
  ).rejects.toThrow("notes changed on disk since Settings showed it. Reopen Settings.");

  const revision = specialistFileRevision(await readFile(notes.path));
  await expect(
    workflow.shareSpecialist(project, { name: "notes", revision, target: outside }),
  ).rejects.toThrow("is not a repository Tandem works in");
  await expect(
    workflow.shareSpecialist(project, { name: "notes", revision, target: join(code, "old") }),
  ).rejects.toThrow("old has no GitHub remote");
  expect(created).toEqual([]);
});

const DRAFT = {
  request: "make me a specialist that writes release notes from merged PRs",
  name: "release-notes",
  fields: {
    label: "Release notes",
    instructions: "Group merged PRs by area.",
    steps: ["Collect PRs"],
  },
};

function draftAction(repoPath: string, name = DRAFT.name): TandemAction {
  return { action: "draft-specialist", repoPath, request: DRAFT.request, name, ...DRAFT.fields };
}

/** The coordinator's service, as far as `draft-specialist` reaches into it. */
function draftService(workflow: SetupWorkflow): TandemService {
  const service: Pick<
    TandemService,
    "specialistDraftSurface" | "previewSpecialistDraft" | "draftSpecialist"
  > = {
    specialistDraftSurface: workflow.draftSurface,
    previewSpecialistDraft: (repoPath, draft) => workflow.previewSpecialistDraft(repoPath, draft),
    draftSpecialist: (repoPath, draft) => workflow.draftSpecialist(repoPath, draft),
  };
  return service as TandemService;
}

test("on Herdr a chat draft is written only after the user sees the whole file and says yes", async () => {
  const { workflow, code, tandemHome } = await machine();
  const repoPath = join(code, "api");
  const service = draftService(workflow);
  const path = join(tandemHome, "specialists", "release-notes.md");
  const asked: string[] = [];

  const declined = await executeTandemAction(draftAction(repoPath), service, {
    confirm: async (title, message) => {
      asked.push(`${title}\n${message}`);
      return false;
    },
  });
  expect(declined.approved).toBe(false);
  expect(await readdir(tandemHome)).toEqual([]);

  const approved = await executeTandemAction(draftAction(repoPath), service, {
    confirm: async () => true,
  });
  expect(approved).toMatchObject({
    approved: true,
    value: `Saved ${path}. New implementation tasks can use it.`,
  });
  const text = await readFile(path, "utf8");
  expect(asked).toEqual([`Save the specialist "Release notes" to Just me?\n${path}\n\n${text}`]);
  expect(text).toContain("## Steps\n- Collect PRs");

  let dialogs = 0;
  await expect(
    executeTandemAction(draftAction(repoPath), service, {
      confirm: async () => {
        dialogs += 1;
        return true;
      },
    }),
  ).rejects.toThrow("Just me already has release-notes");
  expect(dialogs).toBe(0);
  expect(await readFile(path, "utf8")).toBe(text);
  await rm(path);
  const unattended = await executeTandemAction(draftAction(repoPath), service, {
    confirm: undefined,
  });
  expect(unattended.approved).toBe(false);
  expect(await readdir(join(tandemHome, "specialists"))).toEqual([]);
});

test("on Tern a chat draft opens Settings at Specialists unsaved and writes nothing", async () => {
  const { workflow, opened, code, tandemHome } = await machine({ tern: true });
  const repoPath = join(code, "api");
  const service = draftService(workflow);

  const result = await executeTandemAction(draftAction(repoPath), service, { confirm: undefined });
  expect(result.value).toBe(
    "Opened Settings › Specialists with release-notes as an unsaved draft. Nothing is saved until the user presses Save changes there.",
  );
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ mode: "settings", section: "specialists", chatDraft: DRAFT });
  expect(await readdir(tandemHome)).toEqual([]);

  await changeHomeSpecialist(tandemHome, { op: "create", name: "release-notes", fields: NOTES });
  const again = await executeTandemAction(draftAction(repoPath), service, { confirm: undefined });
  expect(again.value).toContain("Saving replaces your current release-notes.");
  expect(await readdir(join(tandemHome, "specialists"))).toEqual(["release-notes.md"]);

  await expect(
    executeTandemAction(draftAction(repoPath, "Release Notes"), service, { confirm: undefined }),
  ).rejects.toThrow("is not a specialist name");
  expect(opened).toHaveLength(2);
});

test("while Settings can't open, a chat draft on Tern fails with the reason and writes nothing", async () => {
  const refusal = "Finish setting up Tandem first. Settings open once setup is saved.";
  const { workflow, opened, code, tandemHome } = await machine({ tern: true, refusal });
  const repoPath = join(code, "api");
  await expect(workflow.view(repoPath, "settings")).rejects.toThrow(refusal);
  expect((await workflow.view(repoPath, "setup")).mode).toBe("setup");
  await expect(
    executeTandemAction(draftAction(repoPath), draftService(workflow), { confirm: undefined }),
  ).rejects.toThrow(refusal);
  expect(opened).toEqual([]);
  expect(await readdir(tandemHome)).toEqual([]);
});
