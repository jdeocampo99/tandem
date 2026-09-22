import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCommand } from "../../src/adapters/commands.ts";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import { onboardRepo } from "../../src/config/repositories.ts";
import type { CommandRequest, CommandResult, ModelSpec, RepoPolicy } from "../../src/contracts.ts";
import { runTerminal } from "../../src/main.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { parseTerminalArgs } from "../../src/terminal/arguments.ts";
import type { CliApplication } from "../../src/terminal/cli-application.ts";
import type { CliInvocation } from "../../src/terminal/cli-arguments.ts";

const roles = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "verifier",
  "presentation",
] as const;

function catalogue(): readonly OmpModelRecord[] {
  return [
    {
      selector: "test/model",
      id: "model",
      provider: "test",
      thinking: ["low", "high"],
    },
  ];
}

/** A catalogue with explicit reasoning evidence, so Balanced can resolve every role from it. */
function balancedCatalogue(): readonly OmpModelRecord[] {
  return [
    {
      selector: "acme/balanced",
      id: "balanced",
      provider: "acme",
      thinking: ["low", "medium", "high", "max"],
      reasoning: true,
    },
  ];
}

function onboardingService(
  options: Readonly<{
    existingConfig: boolean;
    configured: boolean;
    catalogue?: readonly OmpModelRecord[];
    enabledProviders?: readonly string[];
  }>,
): {
  readonly service: TandemService;
  readonly configureCalls: ModelSpec[][];
  readonly providerCalls: (readonly string[] | undefined)[];
  readonly writeCalls: string[];
} {
  const configureCalls: ModelSpec[][] = [];
  const providerCalls: (readonly string[] | undefined)[] = [];
  const writeCalls: string[] = [];
  const models = options.configured
    ? {
        coordinator: { model: "test/model", thinking: "low" },
        scout: { model: "test/model", thinking: "low" },
        implementer: { model: "test/model", thinking: "low" },
        reviewer: { model: "test/model", thinking: "low" },
        verifier: { model: "test/model", thinking: "low" },
        presentation: { model: "test/model", thinking: "low" },
      }
    : undefined;
  const enabledProviders = options.enabledProviders ?? [];
  const service = {
    onboard: async (repoPath: string, write = false) => {
      if (write) writeCalls.push(repoPath);
      return {
        repoPath,
        configPath: "/private/tandem/repositories/test/config.json",
        existingConfig: options.existingConfig,
        written: write,
        approvalRequired: !options.existingConfig,
        modelSettings: {
          configPath: "/private/tandem/models.json",
          configured: options.configured,
          enabledProviders,
          ...(models === undefined ? {} : { models }),
        },
        policy: {} as never,
        proposedPolicy: {} as never,
        validationCommands: [],
        unresolved: [],
      };
    },
    models: async () => ({
      modelSettings: {
        configPath: "/private/tandem/models.json",
        configured: options.configured,
        enabledProviders,
        ...(models === undefined ? {} : { models }),
      },
      availableModels: options.catalogue ?? catalogue(),
    }),
    configureModels: async (input: {
      readonly models: RepoPolicy["models"];
      readonly enabledProviders?: readonly string[];
    }) => {
      configureCalls.push(Object.values(input.models));
      providerCalls.push(input.enabledProviders);
      return {
        configPath: "/private/tandem/models.json",
        configured: true,
        models: input.models,
        enabledProviders: input.enabledProviders ?? enabledProviders,
      };
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  return { service, configureCalls, providerCalls, writeCalls };
}

function fakeApplication(invocations: CliInvocation[]): CliApplication {
  return {
    invoke: async (invocation) => {
      invocations.push(invocation);
      return {
        command: invocation.command,
        value: { workspaceId: `workspace-${invocations.length}` },
      };
    },
    shutdown: async () => undefined,
  };
}

async function gitProjects(count: number): Promise<readonly string[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-main-test-")));
  const projects: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const project = join(root, `project-${index}`);
    await mkdir(project, { recursive: true });
    const initialized = await runCommand({ argv: ["git", "init"], cwd: project });
    if (initialized.code !== 0) {
      throw new Error(`test Git repository could not be initialized: ${initialized.stderr}`);
    }
    projects.push(project);
  }
  return projects;
}
async function registerProjects(home: string, projects: readonly string[]): Promise<void> {
  const directory = join(home, "repositories");
  await mkdir(directory, { recursive: true });
  for (const [index, repoPath] of projects.entries()) {
    const projectDirectory = join(directory, `project-${index}`);
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      join(projectDirectory, "config.json"),
      JSON.stringify({ schemaVersion: 1, repoPath }),
      "utf8",
    );
  }
}

const OSC_PALETTE_REPLY = "\x1b]4;142;rgb:1357/2468/abcd\x07";
const SGR_MOUSE_INPUT = "\x1b[<0;12;8M";
const CHILD_TYPING = "child-typing";

function ttyStreams(): Readonly<{ input: PassThrough; output: PassThrough }> {
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
  });
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns: 100 });
  return { input, output };
}

async function feedInteractiveInput(
  input: PassThrough,
  onChildInput: (text: string) => void,
): Promise<number> {
  const onData = (chunk: Buffer | string): void => {
    onChildInput(chunk.toString());
  };
  input.on("data", onData);
  input.resume();
  try {
    input.write(OSC_PALETTE_REPLY);
    await Bun.sleep(20);
    input.write(SGR_MOUSE_INPUT);
    await Bun.sleep(20);
    input.write(CHILD_TYPING);
    await Bun.sleep(20);
    return 0;
  } finally {
    input.off("data", onData);
  }
}

test("declining the first-run role recap performs no model write and no launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  // The single discovered "test" provider has no reasoning-capability evidence in this fixture's
  // catalogue, so Balanced always stays unresolved here and onboarding falls through to the manual
  // six-role loop regardless of the enable/skip answer.
  const answers = ["enable", ...roles.flatMap(() => ["test/model", "low"])];
  answers.push("not now");
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("cancelled");
  expect(fake.configureCalls).toHaveLength(0);
  expect(fake.writeCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("unsupported thinking fails before any model write or coordinator launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", "test/model", "max"];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("error");
  expect(fake.configureCalls).toHaveLength(0);
  expect(fake.writeCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("non-TTY first-run onboarding fails with no write and no launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: false, configured: false });
  const invocations: CliInvocation[] = [];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("interactive terminal");
  expect(fake.configureCalls).toHaveLength(0);
  expect(fake.writeCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("explicit role answers are sent to the service only after the complete recap is saved", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", ...roles.flatMap(() => ["test/model", "high"])];
  answers.push("save");
  const result = await runTerminal([repo, "--home", home, "--headless"], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(fake.configureCalls).toHaveLength(1);
  expect(fake.configureCalls[0]).toHaveLength(6);
  expect(
    fake.configureCalls[0]?.every(
      (model) => model.model === "test/model" && model.thinking === "high",
    ),
  ).toBe(true);
  expect(invocations).toHaveLength(1);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("first-run onboarding accepts a resolved Balanced proposal without six separate role questions", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({
    existingConfig: true,
    configured: false,
    catalogue: balancedCatalogue(),
  });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", "accept"];
  const result = await runTerminal([repo, "--home", home, "--headless"], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(fake.configureCalls).toEqual([
    [
      { model: "acme/balanced", thinking: "high" },
      { model: "acme/balanced", thinking: "medium" },
      { model: "acme/balanced", thinking: "max" },
      { model: "acme/balanced", thinking: "max" },
      { model: "acme/balanced", thinking: "high" },
      { model: "acme/balanced", thinking: "low" },
    ],
  ]);
  expect(fake.providerCalls).toEqual([["acme"]]);
  expect(invocations).toHaveLength(1);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("first-run onboarding lets the user inspect and override a resolved Balanced proposal", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({
    existingConfig: true,
    configured: false,
    catalogue: balancedCatalogue(),
  });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", "override", ...roles.flatMap(() => ["acme/balanced", "low"]), "save"];
  const result = await runTerminal([repo, "--home", home, "--headless"], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(fake.configureCalls).toHaveLength(1);
  expect(
    fake.configureCalls[0]?.every(
      (model) => model.model === "acme/balanced" && model.thinking === "low",
    ),
  ).toBe(true);
  expect(fake.providerCalls).toEqual([["acme"]]);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("first-run onboarding discloses the exact unresolved reason and falls back to manual roles", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  // The default fixture catalogue has no reasoning-capability evidence, so Balanced can never
  // resolve any role from it regardless of provider enablement.
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", ...roles.flatMap(() => ["test/model", "low"])];
  answers.push("not now");
  const output: string[] = [];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: true,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("cancelled");
  expect(fake.configureCalls).toHaveLength(0);
  const rendered = output.join("");
  expect(rendered).toContain("Balanced could not resolve every role");
  expect(rendered).toContain("no built-in pin, fuzzy alias, or silent fallback");
  expect(rendered).toContain("no explicit reasoning-capability evidence");
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("declining project settings through the keyboard menu performs no write or launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const parent = join(repo, "..");
  const home = join(parent, "home");
  const { input, output } = ttyStreams();
  const fake = onboardingService({ existingConfig: false, configured: true });
  const invocations: CliInvocation[] = [];
  const prompts = ["Choose Keep all, Change roles, or Not now", "Save project settings?"];
  const keys = ["\r", "\u001b[B\r"];
  let rendered = "";
  let nextPrompt = 0;
  output.on("data", (chunk: Buffer | string) => {
    rendered += chunk.toString();
    const marker = prompts[nextPrompt];
    if (marker === undefined) return;
    const start = rendered.lastIndexOf(marker);
    if (start < 0 || !rendered.slice(start).includes("❯")) return;
    const answer = keys[nextPrompt++];
    if (answer !== undefined) queueMicrotask(() => input.write(answer));
  });
  try {
    const result = await runTerminal([repo, "--home", home, "--headless"], {
      cwd: repo,
      run: runCommand,
      service: fake.service,
      application: fakeApplication(invocations),
      input,
      output,
      isTTY: true,
      stderr: () => undefined,
    });
    expect(result.status).toBe("cancelled");
    expect(fake.configureCalls).toHaveLength(0);
    expect(fake.writeCalls).toHaveLength(0);
    expect(invocations).toHaveLength(0);
  } finally {
    input.destroy();
    output.destroy();
    await rm(parent, { recursive: true, force: true });
  }
});

test("focuses the requested coordinator workspace before one Herdr attach", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const focusCalls: CommandRequest[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (
      request.argv[0] === "herdr" &&
      request.argv[1] === "--session" &&
      request.argv[2] === "tandem" &&
      request.argv[3] === "workspace" &&
      request.argv[4] === "focus"
    ) {
      focusCalls.push(request);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (request.argv[0] === "herdr")
      throw new Error("unexpected native Herdr command in terminal test");
    return runCommand(request);
  };
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const interactiveCalls: CommandRequest[] = [];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    processEnvironment: {},
    run,
    service: fake.service,
    application: fakeApplication(invocations),
    runInteractive: async (request) => {
      interactiveCalls.push(request as CommandRequest);
      return 0;
    },
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(focusCalls.map((call) => call.argv)).toEqual([
    ["herdr", "--session", "tandem", "workspace", "focus", "workspace-1"],
  ]);
  expect(interactiveCalls.map((call) => call.argv)).toEqual([["herdr", "--session", "tandem"]]);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("multiple explicit projects use one selected session without inheriting another project's source or parent", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  const second = projects[1];
  if (first === undefined || second === undefined)
    throw new Error("test projects were not created");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  let processEnvironment: Record<string, string | undefined> | undefined;
  const home = join(first, "..", "home");
  const application: CliApplication = {
    invoke: async (invocation) => {
      invocations.push(invocation);
      return {
        command: invocation.command,
        value: { workspaceId: `workspace-${invocations.length}` },
      };
    },
    shutdown: async () => undefined,
  };
  const result = await runTerminal([first, second, "--home", home], {
    cwd: first,
    run: runCommand,
    service: fake.service,
    createApplication: (dependencies) => {
      processEnvironment = dependencies.processEnvironment as Record<string, string | undefined>;
      return application;
    },
    processEnvironment: {
      TANDEM_SESSION: "shared-session",
      TANDEM_SOURCE_REPO: "/private/project-a-clean",
      TANDEM_PARENT_WORKSPACE: "workspace-a",
      HERDR_ENV: "1",
      HERDR_SESSION: "shared-session",
      HERDR_WORKSPACE_ID: "workspace-a",
      HERDR_PANE_ID: "pane-a",
    },
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(invocations).toHaveLength(2);
  expect(invocations.map((invocation) => invocation.options.sessionId)).toEqual([
    "shared-session",
    "shared-session",
  ]);
  expect(invocations.map((invocation) => invocation.options.repo)).toEqual([first, second]);
  expect(processEnvironment?.TANDEM_SOURCE_REPO).toBeUndefined();
  expect(processEnvironment?.TANDEM_PARENT_WORKSPACE).toBeUndefined();
  await rm(join(first, ".."), { recursive: true, force: true });
});

test("bare launch opens all saved projects from an unrelated cwd and attaches once", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  if (first === undefined) throw new Error("test project was not created");
  const parent = join(first, "..");
  const cwd = join(parent, "outside");
  const home = join(parent, "home");
  await mkdir(cwd);
  await registerProjects(home, projects);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const focusCalls: CommandRequest[] = [];
  const attachCalls: CommandRequest[] = [];
  const promptCalls: string[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (
      request.argv[0] === "herdr" &&
      request.argv[1] === "--session" &&
      request.argv[2] === "tandem" &&
      request.argv[3] === "workspace" &&
      request.argv[4] === "focus"
    ) {
      focusCalls.push(request);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (request.argv[0] === "herdr")
      throw new Error("unexpected native Herdr command in terminal test");
    return runCommand(request);
  };
  const result = await runTerminal(["--home", home], {
    cwd,
    processEnvironment: {},
    run,
    service: fake.service,
    application: fakeApplication(invocations),
    runInteractive: async (request) => {
      attachCalls.push(request as CommandRequest);
      return 0;
    },
    prompt: async (question) => {
      promptCalls.push(question);
      return "all";
    },
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(result.projects).toEqual(projects);
  expect(invocations.map((invocation) => invocation.options.repo)).toEqual([...projects]);
  expect(invocations.map((invocation) => invocation.options.sessionId)).toEqual([
    "tandem",
    "tandem",
  ]);
  expect(focusCalls.map((call) => call.argv)).toEqual([
    ["herdr", "--session", "tandem", "workspace", "focus", "workspace-1"],
  ]);
  expect(attachCalls.map((call) => call.argv)).toEqual([["herdr", "--session", "tandem"]]);
  expect(promptCalls).toHaveLength(0);
  await rm(parent, { recursive: true, force: true });
});

test("bare non-TTY launch inside a saved repo opens every saved project", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  if (first === undefined) throw new Error("test project was not created");
  const home = join(first, "..", "home");
  await registerProjects(home, projects);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const result = await runTerminal(["--home", home], {
    cwd: first,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(result.projects).toEqual(projects);
  expect(invocations.map((invocation) => invocation.options.repo)).toEqual([...projects]);
  await rm(join(first, ".."), { recursive: true, force: true });
});

test("explicit project paths override saved projects with only the requested subset", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  const second = projects[1];
  if (first === undefined || second === undefined)
    throw new Error("test projects were not created");
  const home = join(first, "..", "home");
  await registerProjects(home, projects);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const result = await runTerminal([first, "--home", home], {
    cwd: second,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(result.projects).toEqual([first]);
  expect(invocations.map((invocation) => invocation.options.repo)).toEqual([first]);
  await rm(join(first, ".."), { recursive: true, force: true });
});

test("configure keeps one current-project anchor when several projects are saved", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  const second = projects[1];
  if (first === undefined || second === undefined)
    throw new Error("test projects were not created");
  const home = join(first, "..", "home");
  await registerProjects(home, projects);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const promptCalls: string[] = [];
  const result = await runTerminal(["configure", "--home", home], {
    cwd: second,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async (question) => {
      promptCalls.push(question);
      return "keep all";
    },
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("configured");
  expect(result.projects).toEqual([second]);
  expect(fake.configureCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);
  expect(promptCalls).toHaveLength(1);
  await rm(join(first, ".."), { recursive: true, force: true });
});

test("returning onboarding shows the saved enabled providers and Keep all stays read-only", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({
    existingConfig: true,
    configured: true,
    enabledProviders: ["acme", "globex"],
  });
  const invocations: CliInvocation[] = [];
  const output: string[] = [];
  const result = await runTerminal(["configure", "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => "keep all",
    isTTY: true,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("configured");
  expect(fake.configureCalls).toHaveLength(0);
  const rendered = output.join("");
  expect(rendered).toContain("Enabled providers (explicit spending permission): acme, globex");
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("bare launch with an empty registry keeps current-Git onboarding", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = ["enable", ...roles.flatMap(() => ["test/model", "low"])];
  answers.push("save");
  const result = await runTerminal(["--home", home, "--headless"], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    prompt: async () => answers.shift() ?? "not now",
    isTTY: true,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(fake.configureCalls).toHaveLength(1);
  expect(invocations.map((invocation) => invocation.options.repo)).toEqual([repo]);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("saved interactive launch keeps terminal replies out of visible output", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const parent = join(repo, "..");
  const home = join(parent, "home");
  const { input, output } = ttyStreams();
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  let rendered = "";
  let childInput = "";
  output.on("data", (chunk: Buffer | string) => {
    rendered += chunk.toString();
  });
  try {
    const result = await runTerminal([repo, "--home", home], {
      cwd: repo,
      processEnvironment: {},
      input,
      output,
      isTTY: true,
      run: async (request) => {
        if (
          request.argv[0] === "herdr" &&
          request.argv[1] === "--session" &&
          request.argv[2] === "tandem" &&
          request.argv[3] === "workspace" &&
          request.argv[4] === "focus"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (request.argv[0] === "herdr")
          throw new Error("unexpected native Herdr command in terminal test");
        return runCommand(request);
      },
      service: fake.service,
      application: fakeApplication(invocations),
      runInteractive: async () =>
        feedInteractiveInput(input, (text) => {
          childInput += text;
        }),
    });
    expect(result.status).toBe("launched");
    expect(invocations).toHaveLength(1);
    expect(childInput).toBe(`${OSC_PALETTE_REPLY}${SGR_MOUSE_INPUT}${CHILD_TYPING}`);
    expect(rendered).not.toContain(OSC_PALETTE_REPLY);
    expect(rendered).not.toContain("rgb:1357/2468/abcd");
    expect(rendered).not.toContain(SGR_MOUSE_INPUT);
    expect(rendered).not.toContain("0;12;8M");
  } finally {
    input.destroy();
    output.destroy();
    await rm(parent, { recursive: true, force: true });
  }
});

test("keyboard onboarding releases terminal input before Herdr attachment", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const parent = join(repo, "..");
  const home = join(parent, "home");
  const { input, output } = ttyStreams();
  const fake = onboardingService({ existingConfig: false, configured: false });
  const invocations: CliInvocation[] = [];
  const promptMarkers = [
    "Enable test for automatic Balanced selection?",
    "Planning model selector",
    "Planning thinking level",
    "Research model selector",
    "Research thinking level",
    "Coding model selector",
    "Coding thinking level",
    "Review model selector",
    "Review thinking level",
    "Final checks model selector",
    "Final checks thinking level",
    "Presentations model selector",
    "Presentations thinking level",
    "Save these six choices?",
    "Save project settings?",
  ] as const;
  const keySequences = [
    // Accept the default "Skip": the fixture catalogue has no reasoning-capability evidence, so
    // Balanced stays unresolved regardless and onboarding falls through to the manual role loop.
    "\r",
    "\r",
    "l\r",
    "\r",
    "l\r",
    "\r",
    "l\r",
    "\r",
    "l\r",
    "\r",
    "l\r",
    "\r",
    "l\r",
    "\u001b[A\r",
    "\r",
  ] as const;
  let rendered = "";
  let nextPrompt = 0;
  let childInput = "";
  const onOutput = (chunk: Buffer | string): void => {
    rendered += chunk.toString();
    while (nextPrompt < promptMarkers.length) {
      const marker = promptMarkers[nextPrompt];
      const keySequence = keySequences[nextPrompt];
      if (marker === undefined || keySequence === undefined) break;
      const promptStart = rendered.lastIndexOf(marker);
      if (promptStart < 0 || !rendered.slice(promptStart).includes("❯")) break;
      nextPrompt += 1;
      queueMicrotask(() => {
        input.write(keySequence);
      });
    }
  };
  output.on("data", onOutput);
  try {
    const result = await runTerminal([repo, "--home", home], {
      cwd: repo,
      processEnvironment: {},
      input,
      output,
      isTTY: true,
      run: async (request) => {
        if (
          request.argv[0] === "herdr" &&
          request.argv[1] === "--session" &&
          request.argv[2] === "tandem" &&
          request.argv[3] === "workspace" &&
          request.argv[4] === "focus"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (request.argv[0] === "herdr")
          throw new Error("unexpected native Herdr command in terminal test");
        return runCommand(request);
      },
      service: fake.service,
      application: fakeApplication(invocations),
      runInteractive: async () =>
        feedInteractiveInput(input, (text) => {
          childInput += text;
        }),
    });
    expect(result.status).toBe("launched");
    expect(fake.configureCalls).toHaveLength(1);
    expect(fake.configureCalls[0]).toHaveLength(6);
    expect(
      fake.configureCalls[0]?.every(
        (model) => model.model === "test/model" && model.thinking === "low",
      ),
    ).toBe(true);
    expect(fake.writeCalls).toEqual([repo]);
    expect(invocations).toHaveLength(1);
    expect(nextPrompt).toBe(promptMarkers.length);
    expect(childInput).toBe(`${OSC_PALETTE_REPLY}${SGR_MOUSE_INPUT}${CHILD_TYPING}`);
    expect(rendered).not.toContain(OSC_PALETTE_REPLY);
    expect(rendered).not.toContain("rgb:1357/2468/abcd");
    expect(rendered).not.toContain(SGR_MOUSE_INPUT);
    expect(rendered).not.toContain("0;12;8M");
  } finally {
    output.off("data", onOutput);
    input.destroy();
    output.destroy();
    await rm(parent, { recursive: true, force: true });
  }
});

test("cancelling keyboard onboarding before the first selection does not configure or launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const parent = join(repo, "..");
  const home = join(parent, "home");
  const { input, output } = ttyStreams();
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  let rendered = "";
  let cancelled = false;
  const onOutput = (chunk: Buffer | string): void => {
    rendered += chunk.toString();
    if (!cancelled && rendered.includes("Enable test for automatic Balanced selection?")) {
      cancelled = true;
      queueMicrotask(() => {
        input.write("\u0003");
      });
    }
  };
  output.on("data", onOutput);
  try {
    const result = await runTerminal([repo, "--home", home], {
      cwd: repo,
      processEnvironment: {},
      input,
      output,
      isTTY: true,
      run: runCommand,
      service: fake.service,
      application: fakeApplication(invocations),
    });
    expect(result.status).toBe("cancelled");
    expect(fake.configureCalls).toHaveLength(0);
    expect(fake.writeCalls).toHaveLength(0);
    expect(invocations).toHaveLength(0);
  } finally {
    output.off("data", onOutput);
    input.destroy();
    output.destroy();
    await rm(parent, { recursive: true, force: true });
  }
});

test("reset stops only the selected coordinators before fresh launch and one attach", async () => {
  const projects = await gitProjects(2);
  const first = projects[0];
  const second = projects[1];
  if (first === undefined || second === undefined)
    throw new Error("test projects were not created");
  const home = join(first, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const events: string[] = [];
  const resetPaths: string[][] = [];
  const output: string[] = [];
  const result = await runTerminal([first, "--reset", "--home", home], {
    cwd: second,
    processEnvironment: {},
    run: async (request) => {
      if (
        request.argv[0] === "herdr" &&
        request.argv[1] === "--session" &&
        request.argv[2] === "tandem" &&
        request.argv[3] === "workspace" &&
        request.argv[4] === "focus"
      ) {
        events.push("focus");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (request.argv[0] === "herdr")
        throw new Error("unexpected native Herdr command in terminal test");
      return runCommand(request);
    },
    service: fake.service,
    application: {
      invoke: async (invocation) => {
        events.push(`launch:${invocation.options.repo}`);
        invocations.push(invocation);
        return {
          command: invocation.command,
          value: { workspaceId: `workspace-${invocations.length}` },
        };
      },
      shutdown: async () => undefined,
    },
    resetCoordinators: async (_run, input) => {
      events.push("reset");
      resetPaths.push([...input.repoPaths]);
      return [];
    },
    runInteractive: async () => {
      events.push("attach");
      return 0;
    },
    isTTY: true,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("launched");
  expect(resetPaths).toEqual([[first]]);
  expect(events).toEqual(["reset", `launch:${first}`, "focus", "attach"]);
  expect(invocations).toHaveLength(1);
  await rm(join(first, ".."), { recursive: true, force: true });
});

test("launch prints a notice when the previous coordinator workspace is retained for an extra pane", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const output: string[] = [];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: {
      invoke: async (invocation) => {
        invocations.push(invocation);
        return {
          command: invocation.command,
          value: {
            workspaceId: "workspace-1",
            workspaceRetirement: {
              outcome: "retained",
              reason: "extra panes still share this workspace",
              extraPaneIds: ["extra-pane"],
            },
          },
        };
      },
      shutdown: async () => undefined,
    },
    isTTY: false,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("launched");
  expect(invocations).toHaveLength(1);
  const rendered = output.join("");
  expect(rendered).toContain(`retained the previous coordinator workspace for ${repo}`);
  expect(rendered).toContain("extra-pane");
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("reset prints a notice when a coordinator's workspace is quarantined", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const output: string[] = [];
  const result = await runTerminal([repo, "--reset", "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    resetCoordinators: async (_run, input) => {
      return input.repoPaths.map((repoPath) => ({
        schemaVersion: 1 as const,
        repoPath,
        endpoint: {
          sessionId: "tandem",
          workspaceId: "workspace-a",
          tabId: "tab-a",
          paneId: "pane-a",
          role: "coordinator" as const,
          generation: 0,
        },
        worktree: {
          root: "/pool",
          path: "/pool/coordinator-a",
          name: "coordinator-a",
          baseHead: "abc123",
          branch: "tandem/coordinator-a",
          leaseId: "lease-a",
          leaseHolder: "coordinator-a",
          leasedAt: "2030-01-02T03:04:05.000Z",
        },
        command: ["omp"],
        workspaceRetirement: {
          outcome: "quarantined" as const,
          reason: "coordinator pane moved outside its recorded worktree",
        },
      }));
    },
    isTTY: false,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("launched");
  const rendered = output.join("");
  expect(rendered).toContain(
    `left an ambiguous previous coordinator pane or workspace untouched for ${repo}`,
  );
  expect(rendered).toContain("moved outside its recorded worktree");
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("terminal argument boundaries keep force launch-only and -- positional", () => {
  expect(parseTerminalArgs(["--reset", "--force", "/repo"]).force).toBe(true);
  expect(parseTerminalArgs(["--force", "--reset", "/repo"]).paths).toEqual(["/repo"]);
  expect(parseTerminalArgs(["--reset", "--force", "--", "--force", "configure"]).paths).toEqual([
    "--force",
    "configure",
  ]);
  expect(() => parseTerminalArgs(["--force"])).toThrow();
  expect(() => parseTerminalArgs(["configure", "--reset", "--force"])).toThrow();
});
test("logs prints recent prompt-routing events without launching a project", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-logs-test-"));
  const logPath = join(home, "logs", "tandem.jsonl");
  await mkdir(join(home, "logs"), { recursive: true });
  await writeFile(
    logPath,
    [
      JSON.stringify({
        timestamp: "2030-01-02T03:04:05.000Z",
        pid: 1,
        event: "prompt-route-evaluated",
        details: { classifier: "jev", reason: "direct-read-only" },
      }),
      JSON.stringify({ timestamp: "2030-01-02T03:04:06.000Z", pid: 1, event: "worker-event" }),
      JSON.stringify({
        timestamp: "2030-01-02T03:04:07.000Z",
        pid: 1,
        event: "prompt-route-dispatched",
        details: { action: "list" },
      }),
    ].join("\n"),
  );
  try {
    expect(parseTerminalArgs(["logs", "--home", home])).toMatchObject({
      command: "logs",
      paths: [],
      home,
    });
    expect(() => parseTerminalArgs(["logs", "/repo"])).toThrow(
      "tandem logs does not accept project paths",
    );
    const output: string[] = [];
    const result = await runTerminal(["logs", "--home", home], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "logs" });
    expect(output.join("")).toContain(`Tandem prompt-routing log: ${logPath}`);
    expect(output.join("")).toContain("prompt-route-evaluated");
    expect(output.join("")).toContain("prompt-route-dispatched");
    expect(output.join("")).not.toContain("worker-event");

    const jsonOutput: string[] = [];
    await runTerminal(["logs", "--home", home, "--json"], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      stdout: (text) => jsonOutput.push(text),
      stderr: (text) => jsonOutput.push(text),
    });
    expect(JSON.parse(jsonOutput.join(""))).toHaveLength(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reconcile-resources inspects Tandem resources and applies nothing without --yes", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-reconcile-test-"));
  try {
    expect(parseTerminalArgs(["reconcile-resources", "--home", home])).toMatchObject({
      command: "reconcile-resources",
      paths: [],
      home,
      yes: false,
    });
    expect(parseTerminalArgs(["reconcile-resources", "--home", home, "--yes"]).yes).toBe(true);
    expect(
      parseTerminalArgs(["reconcile-resources", "--home", home, "--yes", "--discard"]),
    ).toMatchObject({
      discard: true,
      yes: true,
    });
    expect(() => parseTerminalArgs(["reconcile-resources", "--discard"])).toThrow(
      "tandem reconcile-resources --discard requires --yes",
    );
    expect(() => parseTerminalArgs(["reconcile-resources", "/repo"])).toThrow(
      "tandem reconcile-resources does not accept project paths",
    );

    const run = async (request: CommandRequest): Promise<CommandResult> => {
      throw new Error(`an empty Tandem home needs no commands: ${request.argv.join(" ")}`);
    };
    const output: string[] = [];
    const result = await runTerminal(["reconcile-resources", "--home", home], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      run,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "reconciled" });
    expect(output.join("")).toContain("changed nothing; rerun with --yes to apply");
    expect(output.join("")).toContain("Nothing to reconcile.");

    const jsonOutput: string[] = [];
    await runTerminal(["reconcile-resources", "--home", home, "--json"], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      run,
      stdout: (text) => jsonOutput.push(text),
      stderr: (text) => jsonOutput.push(text),
    });
    expect(JSON.parse(jsonOutput.join(""))).toMatchObject({
      schemaVersion: 1,
      mode: "dry-run",
      cleaned: [],
      retained: [],
      quarantined: [],
      failed: [],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restart is a command alias for the coordinator restart flag", () => {
  expect(parseTerminalArgs(["restart"])).toMatchObject({
    command: "launch",
    paths: [],
    restart: true,
  });
  expect(parseTerminalArgs(["restart", "/repo"]).paths).toEqual(["/repo"]);
  expect(parseTerminalArgs(["--", "restart"]).paths).toEqual(["restart"]);
  expect(parseTerminalArgs(["--restart", "restart"]).paths).toEqual(["restart"]);
});

test("a reset refusal prevents every coordinator launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  let resetCalls = 0;
  const result = await runTerminal([repo, "--reset", "--home", home, "--headless"], {
    cwd: repo,
    processEnvironment: {},
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    resetCoordinators: async () => {
      resetCalls += 1;
      throw new Error("selected coordinator is busy");
    },
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("selected coordinator is busy");
  expect(resetCalls).toBe(1);
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("configure --reset and reset inside Herdr reject before any mutation", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const configureResult = await runTerminal(["configure", "--reset", repo, "--home", home], {
    cwd: repo,
    processEnvironment: {},
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(configureResult.status).toBe("error");
  expect(configureResult.error?.message).toContain("launch-only");
  expect(fake.writeCalls).toHaveLength(0);
  expect(fake.configureCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);

  const contextResult = await runTerminal([repo, "--reset", "--home", home], {
    cwd: repo,
    processEnvironment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "tandem",
      HERDR_WORKSPACE_ID: "workspace-parent",
      HERDR_PANE_ID: "pane-parent",
    },
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    resetCoordinators: async () => {
      throw new Error("reset should not be reached from Herdr");
    },
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(contextResult.status).toBe("error");
  expect(contextResult.error?.message).toContain("separate normal terminal");
  expect(fake.writeCalls).toHaveLength(0);
  expect(fake.configureCalls).toHaveLength(0);
  expect(invocations).toHaveLength(0);
  const restartResult = await runTerminal([repo, "--restart", "--home", home], {
    cwd: repo,
    processEnvironment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "tandem",
      HERDR_WORKSPACE_ID: "workspace-parent",
      HERDR_PANE_ID: "pane-parent",
    },
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(restartResult.status).toBe("error");
  expect(restartResult.error?.message).toContain("tandem --restart cannot run from inside Herdr");
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("config opens the project's settings in $EDITOR and re-checks them after", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const editorCalls: (readonly string[])[] = [];
  const options = {
    cwd: repo,
    run: runCommand,
    processEnvironment: { EDITOR: "vi" },
    runInteractive: async (request: { readonly argv: readonly string[] }) => {
      editorCalls.push(request.argv);
      return 0;
    },
    stdout: () => undefined,
    stderr: () => undefined,
  };

  const missing = await runTerminal(["config", "--home", home], options);
  expect(missing.exitCode).toBe(1);
  expect(missing.error?.message).toContain("no Tandem settings yet");
  expect(editorCalls).toHaveLength(0);

  const { configPath } = await onboardRepo({ repoPath: repo, home, write: true });
  const result = await runTerminal(["config", "--home", home], options);
  expect(result.status).toBe("configured");
  expect(editorCalls).toEqual([["/bin/sh", "-c", 'vi "$1"', "sh", configPath]]);

  await writeFile(configPath, "{ not json", "utf8");
  const broken = await runTerminal(["config", "--home", home], options);
  expect(broken.exitCode).toBe(1);
  expect(broken.error?.message).toContain("the settings file has a problem");
  await rm(join(repo, ".."), { recursive: true, force: true });
});
