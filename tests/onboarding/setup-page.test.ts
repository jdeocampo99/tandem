import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import type { ClaudeCodeAvailability } from "../../src/harness/claude-code/availability.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import { type SetupPageDependencies, SetupPageWorkflow } from "../../src/onboarding/setup-page.ts";
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

const OPENED = "session:\n  status: opened\n  url: http://127.0.0.1:4387/session/abc\n";

/** A machine with a code folder holding `api` (new) and `old` (already set up). */
async function machine(
  options: Readonly<{
    polls?: (code: string, outside: string) => string[];
    openOutput?: string;
    fail?: (code: string) => ReadonlySet<string>;
    lavish?: boolean;
    outsideRepo?: boolean;
    picker?: (code: string, outside: string) => CommandResult | Error;
    failScan?: boolean;
    savedRoots?: (code: string, outside: string) => string[];
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
  const calls: CommandRequest[] = [];
  const polls = options.polls?.(code, outside) ?? [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    const [command, first, second, third] = request.argv;
    if (command === "lavish-axi" && first === "--version") {
      return options.lavish === false ? done("", 127) : done("0.1.78");
    }
    if (command === "lavish-axi" && first === "poll") return done(polls.shift() ?? "");
    if (command === "lavish-axi" && first === "end") return done("session:\n  status: ended\n");
    if (command === "osascript") {
      const choice = options.picker?.(code, outside);
      if (choice instanceof Error) throw choice;
      return choice ?? done("", 1);
    }
    if (command === "lavish-axi") return done(options.openOutput ?? OPENED);
    if (command === "git" && third === "remote" && second === outside && options.failScan) {
      throw new Error("checkout inspection failed");
    }
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
    terminal: "herdr",
    selfImprovement: "off",
    selfImprovementChosen: false,
    projectRoots: options.savedRoots?.(code, outside) ?? [],
  };
  const fail = options.fail?.(code) ?? new Set<string>();
  const record = (name: string) => async () => {
    saved.push(name);
    if (fail.has(name)) throw new Error(`${name} broke`);
  };
  let id = 0;
  const deps: SetupPageDependencies = {
    home,
    homeFolder: root,
    run,
    clock: () => "2026-09-26T12:00:00.000Z",
    idFactory: () => `answer-${++id}`,
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
      scripts: ["test"],
      setupCommands: ["bun install --frozen-lockfile"],
      lockfile: "bun.lock",
    }),
    saveModels: async (input) => {
      saved.push(`models ${input.enabledProviders.join(",")}`);
    },
    configureTerminal: async (terminal) => {
      await record(`terminal ${terminal}`)();
      return { requested: terminal, terminal };
    },
    saveSelfImprovement: async (mode) => record(`mode ${mode}`)(),
    saveCodeFolders: async (folders) => {
      await record(`folders ${folders.join(",")}`)();
      settings = { ...settings, projectRoots: folders };
    },
    setupRepo: async (path, repo) =>
      record(`setup ${path} ${JSON.stringify([repo.validationCommands, repo.setupCommands])}`)(),
    openProject: async (path) => record(`open ${path}`)(),
  };
  return {
    workflow: new SetupPageWorkflow(deps),
    freshWorkflow: () => new SetupPageWorkflow(deps),
    calls,
    saved,
    home,
    code,
    outside,
    find: (name: string) => findCheckoutsByName(name, settings.projectRoots, run),
  };
}

function answerFeedback(repositories: readonly unknown[], scoutModel = "anthropic/opus"): string {
  const answer = {
    tandemSetup: 1,
    models: Object.fromEntries(
      ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
        role,
        { model: role === "scout" ? scoutModel : "anthropic/opus", thinking: "high" },
      ]),
    ),
    repositories,
    terminal: "herdr",
    selfImprovement: "fix",
  };
  return [
    "session:",
    "  status: feedback",
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify(answer))},button#next,tandem-setup,Tandem setup answer`,
  ].join("\n");
}

function searchFeedback(folder: string, draft: unknown): string {
  return [
    "session:",
    "  status: feedback",
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify({ tandemSearch: 1, folder, draft }))},form#folder-search,tandem-search,Search another folder`,
  ].join("\n");
}

function chooseFeedback(draft: unknown): string {
  return [
    "session:",
    "  status: feedback",
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify({ tandemChooseFolder: 1, draft }))},button#choose-folder,tandem-choose-folder,Choose folder`,
  ].join("\n");
}

const chooserDraft = {
  picks: { coordinator: { model: "anthropic/opus", thinking: "high" } },
  repositories: [],
  terminal: "herdr",
  selfImprovement: "report",
};

function pageData(html: string): Record<string, unknown> {
  const data = html.match(
    /<script type="application\/json" id="setup-data">([^<]+)<\/script>/,
  )?.[1];
  if (!data) throw new Error("Setup page has no view data");
  return JSON.parse(data) as Record<string, unknown>;
}

test("the page opens in Lavish from the Tandem home, reopening a session the user ended", async () => {
  const { workflow, calls, home } = await machine();
  expect(await workflow.status()).toBe("ready");
  const opened = await workflow.open("/tandem");
  expect(opened).toEqual({
    path: join(home, "setup", "tandem-setup.html"),
    url: "http://127.0.0.1:4387/session/abc",
  });
  expect(calls.at(-1)?.argv).toEqual(["lavish-axi", opened.path, "--reopen"]);
  const html = await readFile(opened.path, "utf8");
  expect(html).toContain('"name":"api"');
  expect(html).toContain('"setUp":true');
  expect(await workflow.status()).toBe("open");
});

test("without Lavish, or when it cannot open the page, setup stays in the chat", async () => {
  const missing = await machine({ lavish: false });
  expect(await missing.workflow.status()).toBe("unavailable");

  const broken = await machine({ openOutput: "error: port in use\ncode: SERVER\n" });
  await expect(broken.workflow.open("/tandem")).rejects.toThrow(
    "Lavish couldn't open the page. (port in use) Continue setup in the chat.",
  );
  expect(await broken.workflow.status()).toBe("done");
});

test("a valid answer is stored for one Save and saved in order", async () => {
  const { workflow, saved, code, calls } = await machine({
    polls: (code) => [
      answerFeedback([
        {
          path: join(code, "api"),
          validationCommands: ["make check"],
          setupCommands: [],
        },
      ]),
    ],
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal, "hello");
  const poll = calls.find((call) => call.argv[1] === "poll");
  expect(poll?.argv.slice(-2)).toEqual(["--agent-reply", "hello"]);
  if (event.kind !== "answer") throw new Error(`expected an answer, got ${event.kind}`);
  expect(event.answerId).toBe("answer-1");
  await expect(workflow.apply("/tandem", "answer-0")).rejects.toThrow("replaced by a newer one");

  const report = await workflow.apply("/tandem", "answer-1");
  expect(saved).toEqual([
    "terminal herdr",
    "models anthropic",
    "mode fix",
    `folders ${code}`,
    `setup ${join(code, "api")} [["make check"],[]]`,
    `open ${join(code, "api")}`,
  ]);
  expect(report.message).toContain(`api (${join(code, "api")}): its chat is open.`);
  expect(calls.at(-1)?.argv).toEqual(["lavish-axi", "end", workflow.pagePath]);
  expect(await workflow.status()).toBe("done");
  await expect(workflow.apply("/tandem", "answer-1")).rejects.toThrow("No setup page answer");
});

test("approved mixed-model choices enable only the providers used by those models", async () => {
  const availableModels: readonly ModelRecord[] = [
    ...catalogue,
    { selector: "openai/gpt", id: "gpt", provider: "openai", thinking: ["high"] },
    { selector: "google/gemini", id: "gemini", provider: "google", thinking: ["high"] },
  ];
  const { workflow, saved } = await machine({
    availableModels,
    polls: () => [answerFeedback([], "openai/gpt")],
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  if (event.kind !== "answer") throw new Error(`expected an answer, got ${event.kind}`);
  expect(saved).toEqual([]);
  await workflow.apply("/tandem", event.answerId);
  expect(saved[1]).toBe("models anthropic,openai");
});

test("a Claude Code role is saved without enabling Claude Code for spending", async () => {
  const { workflow, saved } = await machine({
    polls: () => [answerFeedback([], "claude-code/sonnet")],
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  if (event.kind !== "answer") throw new Error(`expected an answer, got ${event.kind}`);
  await workflow.apply("/tandem", event.answerId);
  expect(saved[1]).toBe("models anthropic");
});

test("a Claude Code role is refused when Claude Code isn't installed", async () => {
  const { workflow, saved } = await machine({
    claudeCode: "not-installed",
    polls: () => [answerFeedback([], "claude-code/sonnet")],
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  expect(event).toMatchObject({
    kind: "invalid",
    problems: ["Research: claude-code/sonnet isn't available on this computer."],
  });
  expect(saved).toEqual([]);
});

test("a pasted repo outside the scanned folders makes its parent searchable after saving", async () => {
  const { workflow, find, outside } = await machine({
    outsideRepo: true,
    polls: (_code, path) => [answerFeedback([{ path }])],
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  if (event.kind !== "answer") throw new Error(`expected an answer, got ${event.kind}`);
  await workflow.apply("/tandem", event.answerId);
  expect(await find("my-app")).toEqual([{ path: outside }]);
});

test("searching another folder refreshes the page without saving; approval retains existing roots", async () => {
  const { workflow, freshWorkflow, home, saved, outside, code, find } = await machine({
    outsideRepo: true,
    savedRoots: (code) => [join(dirname(code), "previous")],
    polls: (code, outside) => {
      const draft = {
        picks: Object.fromEntries(
          ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
            role,
            { model: "anthropic/opus", thinking: "high" },
          ]),
        ),
        repositories: [
          {
            path: join(code, "api"),
            checks: ["make check"],
            install: "npm ci",
            pasted: false,
          },
        ],
        terminal: "herdr",
        selfImprovement: "report",
      };
      return [searchFeedback(dirname(outside), draft), answerFeedback([{ path: outside }])];
    },
  });
  await workflow.open("/tandem");
  expect(await find("my-app")).toEqual([]);
  const search = await workflow.listen("/tandem", new AbortController().signal);
  expect(search.kind).toBe("search");
  expect(saved).toEqual([]);
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect((view.repos as { path: string }[]).map((repo) => repo.path)).toContain(outside);
  expect(view.draft).toMatchObject({
    repositories: [{ path: join(code, "api"), checks: ["make check"], install: "npm ci" }],
    terminal: "herdr",
    selfImprovement: "report",
  });
  expect(view.pendingFolders).toContain("~/elsewhere");
  expect(await find("my-app")).toEqual([]);

  const answer = await workflow.listen("/tandem", new AbortController().signal);
  if (answer.kind !== "answer") throw new Error(`expected an answer, got ${answer.kind}`);
  await freshWorkflow().apply("/tandem", answer.answerId);
  const folderSave = saved.find((entry) => entry.startsWith("folders "));
  expect(folderSave).toContain(join(dirname(code), "previous"));
  expect(folderSave).toContain(dirname(outside));
  expect(await find("my-app")).toEqual([{ path: outside }]);
});
test("a tagged Save wins over a co-poll folder search and keeps saved roots unchanged", async () => {
  const { workflow, saved } = await machine({
    savedRoots: (root) => [root],
    polls: (_root, folder) => {
      const draft = {
        picks: Object.fromEntries(
          ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
            role,
            { model: "anthropic/opus", thinking: "high" },
          ]),
        ),
        repositories: [],
        terminal: "herdr",
        selfImprovement: "fix",
      };
      const searchRow = `  "1",${JSON.stringify(JSON.stringify({ tandemSearch: 1, folder: dirname(folder), draft }))},form#folder-search,tandem-search,Search another folder`;
      const answerRow = answerFeedback([])
        .split("\n")
        .at(-1)
        ?.replace(/^ {2}"1"/u, '  "2"');
      if (answerRow === undefined) throw new Error("missing answer row");
      return [
        [
          "session:",
          "  status: feedback",
          "prompts[2]{uid,prompt,selector,tag,text}:",
          searchRow,
          answerRow,
        ].join("\n"),
      ];
    },
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  if (event.kind !== "answer") throw new Error(`expected an answer, got ${event.kind}`);
  await workflow.apply("/tandem", event.answerId);
  expect(saved.filter((entry) => entry.startsWith("folders "))).toEqual([]);
});

test("an invalid search folder reports the problem and preserves draft without persisting a root", async () => {
  const { workflow, home, saved } = await machine({
    polls: (code) => [
      searchFeedback(join(code, "does-not-exist"), {
        picks: Object.fromEntries(
          ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
            role,
            { model: "anthropic/opus", thinking: "high" },
          ]),
        ),
        repositories: [],
        terminal: "herdr",
        selfImprovement: "fix",
      }),
    ],
  });
  await workflow.open("/tandem");
  const search = await workflow.listen("/tandem", new AbortController().signal);
  expect(search.kind).toBe("search");
  expect(saved).toEqual([]);
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect(view.searchStatus).toMatchObject({ kind: "error" });
  expect(view.draft).toMatchObject({ terminal: "herdr", selfImprovement: "fix" });
  expect(view.pendingFolders).toEqual([]);
});

test("searching an empty folder reports zero new repos instead of the existing repo count", async () => {
  const { workflow, code, home, saved } = await machine({
    polls: (code) => [
      searchFeedback(join(code, "empty"), {
        picks: {},
        repositories: [],
        terminal: "herdr",
        selfImprovement: "fix",
      }),
    ],
  });
  await mkdir(join(code, "empty"));
  await workflow.open("/tandem");
  const search = await workflow.listen("/tandem", new AbortController().signal);
  if (search.kind !== "search") throw new Error(`expected search, got ${search.kind}`);
  expect(search.reply).toContain("found 0 repos");
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect(view.pendingFolders).toContain("~/code/empty");
  expect((view.repos as { path: string }[]).map((repo) => repo.path)).toContain(join(code, "api"));
  expect(saved).toEqual([]);
});

test("native folder selection scans the chosen directory without approving or losing the draft", async () => {
  const { workflow, home, outside, calls, saved } = await machine({
    outsideRepo: true,
    polls: () => [chooseFeedback(chooserDraft)],
    picker: (_code, outside) => done(`${dirname(outside)}\n`),
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  expect(event).toMatchObject({ kind: "search", reply: expect.stringContaining("found 1 repo") });
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect((view.repos as { path: string }[]).map((repo) => repo.path)).toContain(outside);
  expect(view.pendingFolders).toContain("~/elsewhere");
  expect(view.draft).toMatchObject(chooserDraft);
  expect(saved).toEqual([]);
  expect(calls.filter((call) => call.argv[0] === "osascript")).toHaveLength(1);
});

test("a folder action and queued chat question both finish in the same poll", async () => {
  const { workflow, home, outside } = await machine({
    outsideRepo: true,
    polls: () => [
      `${chooseFeedback(chooserDraft).replace("prompts[1]", "prompts[2]")}\n  "",Where is my repo?,"",message,Freeform message`,
    ],
    picker: (_code, outside) => done(`${dirname(outside)}\n`),
  });
  await workflow.open("/tandem");
  expect(await workflow.listen("/tandem", new AbortController().signal)).toEqual({
    kind: "comment",
    text: "Where is my repo?",
    ended: false,
  });
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect((view.repos as { path: string }[]).map((repo) => repo.path)).toContain(outside);
  expect(view.draft).toMatchObject(chooserDraft);
});

test("canceling the native chooser leaves roots unchanged; a failed chooser offers path entry", async () => {
  const canceled = await machine({
    polls: () => [chooseFeedback(chooserDraft)],
    picker: () => ({ code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }),
  });
  await canceled.workflow.open("/tandem");
  expect(await canceled.workflow.listen("/tandem", new AbortController().signal)).toMatchObject({
    kind: "search",
    reply: "No folder selected.",
  });
  const canceledView = pageData(
    await readFile(join(canceled.home, "setup", "tandem-setup.html"), "utf8"),
  );
  expect(canceledView.pendingFolders).toEqual([]);
  expect(canceledView.draft).toMatchObject(chooserDraft);

  const unavailable = await machine({
    polls: () => [chooseFeedback(chooserDraft)],
    picker: () => new Error("osascript not available"),
  });
  await unavailable.workflow.open("/tandem");
  const error = await unavailable.workflow.listen("/tandem", new AbortController().signal);
  expect(error).toMatchObject({
    kind: "search",
    reply: expect.stringContaining("Enter its path instead"),
  });
  const failedView = pageData(
    await readFile(join(unavailable.home, "setup", "tandem-setup.html"), "utf8"),
  );
  expect(failedView.searchStatus).toMatchObject({ kind: "error" });
  expect(failedView.pendingFolders).toEqual([]);
});

test("a scan failure keeps the previous repo list and does not retain the failed root", async () => {
  const { workflow, home, outside } = await machine({
    outsideRepo: true,
    failScan: true,
    polls: () => [chooseFeedback(chooserDraft)],
    picker: (_code, outside) => done(`${dirname(outside)}\n`),
  });
  await workflow.open("/tandem");
  const event = await workflow.listen("/tandem", new AbortController().signal);
  expect(event).toMatchObject({ kind: "search", reply: expect.stringContaining("scan failed") });
  const view = pageData(await readFile(join(home, "setup", "tandem-setup.html"), "utf8"));
  expect(view.pendingFolders).toEqual([]);
  expect((view.repos as { path: string }[]).map((repo) => repo.path)).not.toContain(outside);
  expect(view.draft).toMatchObject(chooserDraft);
});
test("a failed step is reported without undoing the others, and its chat is not opened", async () => {
  const { workflow, saved, code } = await machine({
    polls: (code) => [answerFeedback([{ path: join(code, "api") }])],
    fail: (code) => new Set([`mode fix`, `setup ${join(code, "api")} [null,null]`]),
  });
  await workflow.open("/tandem");
  await workflow.listen("/tandem", new AbortController().signal);
  const report = await workflow.apply("/tandem", "answer-1");
  expect(report.complete).toBe(false);
  expect(report.message).toContain("The issue setting was not saved: mode fix broke");
  expect(report.message).toContain(`api (${join(code, "api")}): not set up:`);
  expect(saved.some((entry) => entry.startsWith("open "))).toBe(false);
  expect(saved[1]).toBe("models anthropic");
});

test("an answer that can't be saved comes back with every problem and stores nothing", async () => {
  const { workflow, code, home } = await machine({
    polls: (code) => [
      answerFeedback([{ path: join(code, "old") }, { path: join(code, "api", "src") }]),
      'session:\n  status: feedback\nprompts[1]{uid,prompt}:\n  "1",make it blue\n',
      "session:\n  status: ended\n  session_ended: true\n",
    ],
  });
  await workflow.open("/tandem");
  const signal = new AbortController().signal;
  expect(await workflow.listen("/tandem", signal)).toEqual({
    kind: "invalid",
    problems: [
      `${join(code, "old")} is already set up.`,
      `${join(code, "api", "src")} is inside the repository at ${join(code, "api")}; add that folder.`,
    ],
    ended: false,
  });
  expect(await workflow.listen("/tandem", signal)).toEqual({
    kind: "comment",
    text: "make it blue",
    ended: false,
  });
  expect(await workflow.listen("/tandem", signal)).toEqual({ kind: "closed" });
  expect(await workflow.status()).toBe("done");
  await expect(readFile(join(home, "setup", "answer.json"))).rejects.toThrow();
});
