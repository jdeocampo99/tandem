import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import type { HomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { type SetupPageDependencies, SetupPageWorkflow } from "../../src/onboarding/setup-page.ts";

const catalogue: readonly OmpModelRecord[] = [
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
    polls?: (code: string) => string[];
    openOutput?: string;
    fail?: (code: string) => ReadonlySet<string>;
    lavish?: boolean;
  }> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-setup-")));
  roots.push(root);
  const home = join(root, "home");
  const code = join(root, "code");
  for (const repo of ["api", "old", "api/src"]) await mkdir(join(code, repo), { recursive: true });
  for (const repo of ["api", "old"]) await mkdir(join(code, repo, ".git"));
  const calls: CommandRequest[] = [];
  const polls = options.polls?.(code) ?? [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    const [command, first, second, third] = request.argv;
    if (command === "lavish-axi" && first === "--version") {
      return options.lavish === false ? done("", 127) : done("0.1.78");
    }
    if (command === "lavish-axi" && first === "poll") return done(polls.shift() ?? "");
    if (command === "lavish-axi" && first === "end") return done("session:\n  status: ended\n");
    if (command === "lavish-axi") return done(options.openOutput ?? OPENED);
    if (command === "git" && third === "rev-parse") {
      const dir = second ?? "";
      const top = dir.startsWith(join(code, "api")) ? join(code, "api") : join(code, "old");
      return dir.startsWith(code) ? done(`${top}\n`) : done("", 128);
    }
    return done("", 1);
  };
  const saved: string[] = [];
  const settings: HomeSettings = {
    workerSkills: [],
    workerSkillsChosen: false,
    selfImprovement: "off",
    selfImprovementChosen: false,
    projectRoots: [],
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
      availableModels: catalogue,
      modelSettings: {
        configPath: join(home, "models.json"),
        configured: false,
        enabledProviders: [],
        jev: "off",
      },
    }),
    roots: async () => [code, join(root, "missing")],
    homeSettings: async () => settings,
    registeredProjects: async () => [join(code, "old")],
    inspectRepo: async () => ({
      validationCommands: ["bun run test"],
      scripts: ["test"],
      setupCommands: ["bun install --frozen-lockfile"],
      lockfile: "bun.lock",
      mcpServers: ["linear", "sentry"],
    }),
    mcpServers: async () => ["linear", "sentry"],
    skills: async () => [{ name: "tdd", source: "~/.agents/skills", description: "" }],
    saveModels: async (input) => {
      saved.push(`models ${input.enabledProviders.join(",")}`);
    },
    saveWorkerSkills: async (skills) => record(`skills ${skills.join(",")}`)(),
    saveSelfImprovement: async (mode) => record(`mode ${mode}`)(),
    saveCodeFolders: async (folders) => record(`folders ${folders.join(",")}`)(),
    setupRepo: async (path, repo) =>
      record(
        `setup ${path} ${JSON.stringify([repo.validationCommands, repo.setupCommands, repo.coordinatorMcpServers])}`,
      )(),
    openProject: async (path) => record(`open ${path}`)(),
  };
  return { workflow: new SetupPageWorkflow(deps), calls, saved, home, code };
}

function answerFeedback(repositories: readonly unknown[]): string {
  const answer = {
    tandemSetup: 1,
    enabledProviders: ["anthropic"],
    models: Object.fromEntries(
      ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
        role,
        { model: "anthropic/opus", thinking: "high" },
      ]),
    ),
    repositories,
    workerSkills: ["tdd"],
    selfImprovement: "fix",
  };
  return [
    "session:",
    "  status: feedback",
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify(answer))},button#next,tandem-setup,Tandem setup answer`,
  ].join("\n");
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

test("a valid answer is stored for one approval and saved in order", async () => {
  const { workflow, saved, code, calls } = await machine({
    polls: (code) => [
      answerFeedback([
        {
          path: join(code, "api"),
          validationCommands: ["make check"],
          setupCommands: [],
          coordinatorMcpServers: ["linear"],
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
  expect(event.recap).toContain(`Look for repos in: ${code}`);
  expect(await workflow.recap("/tandem", "answer-1")).toEqual(event.recap);
  await expect(workflow.apply("/tandem", "answer-0")).rejects.toThrow("replaced by a newer one");

  const report = await workflow.apply("/tandem", "answer-1");
  expect(saved).toEqual([
    "models anthropic",
    "skills tdd",
    "mode fix",
    `folders ${code}`,
    `setup ${join(code, "api")} [["make check"],[],["linear"]]`,
    `open ${join(code, "api")}`,
  ]);
  expect(report).toContain(`api (${join(code, "api")}): its chat is open.`);
  expect(calls.at(-1)?.argv).toEqual(["lavish-axi", "end", workflow.pagePath]);
  expect(await workflow.status()).toBe("done");
  await expect(workflow.apply("/tandem", "answer-1")).rejects.toThrow("No setup page answer");
});

test("a failed step is reported without undoing the others, and its chat is not opened", async () => {
  const { workflow, saved, code } = await machine({
    polls: (code) => [answerFeedback([{ path: join(code, "api") }])],
    fail: (code) =>
      new Set([`mode fix`, `setup ${join(code, "api")} [null,null,["linear","sentry"]]`]),
  });
  await workflow.open("/tandem");
  await workflow.listen("/tandem", new AbortController().signal);
  const report = await workflow.apply("/tandem", "answer-1");
  expect(report).toContain("The issue setting was not saved: mode fix broke");
  expect(report).toContain(`api (${join(code, "api")}): not set up:`);
  expect(saved.some((entry) => entry.startsWith("open "))).toBe(false);
  expect(saved[0]).toBe("models anthropic");
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
    kind: "other",
    comment: true,
    ended: false,
  });
  expect(await workflow.listen("/tandem", signal)).toEqual({ kind: "closed" });
  expect(await workflow.status()).toBe("done");
  await expect(readFile(join(home, "setup", "answer.json"))).rejects.toThrow();
});
