import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { runCommand } from "../../src/adapters/commands.ts";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import { onboardRepo } from "../../src/config/repositories.ts";
import type { CommandRequest, CommandResult, ModelSpec, RepoPolicy } from "../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { runTerminal } from "../../src/main.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { parseReportSince, parseTerminalArgs } from "../../src/terminal/arguments.ts";
import type { CliApplication } from "../../src/terminal/cli-application.ts";
import type { CliInvocation } from "../../src/terminal/cli-arguments.ts";
import { readRegisteredProjects } from "../../src/terminal/projects.ts";
import { fakeSidebar, saveCoordinator, seedTasks } from "../coordinator/fake-workspace-order.ts";

const roles = ["coordinator", "scout", "implementer", "reviewer", "presentation"] as const;

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
  readonly coordinatorMcpCalls: (readonly string[] | undefined)[];
  readonly jevCalls: ("on" | "off" | undefined)[];
} {
  const configureCalls: ModelSpec[][] = [];
  const providerCalls: (readonly string[] | undefined)[] = [];
  const writeCalls: string[] = [];
  const coordinatorMcpCalls: (readonly string[] | undefined)[] = [];
  const jevCalls: ("on" | "off" | undefined)[] = [];
  const models = options.configured
    ? {
        coordinator: { model: "test/model", thinking: "low" },
        scout: { model: "test/model", thinking: "low" },
        implementer: { model: "test/model", thinking: "low" },
        reviewer: { model: "test/model", thinking: "low" },
        presentation: { model: "test/model", thinking: "low" },
      }
    : undefined;
  const enabledProviders = options.enabledProviders ?? [];
  const service = {
    onboard: async (repoPath: string, write = false, coordinatorMcpServers?: readonly string[]) => {
      if (write) {
        writeCalls.push(repoPath);
        coordinatorMcpCalls.push(coordinatorMcpServers);
      }
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
          jev: "on" as const,
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
        jev: "on" as const,
        ...(models === undefined ? {} : { models }),
      },
      availableModels: options.catalogue ?? catalogue(),
    }),
    configureModels: async (input: {
      readonly models: RepoPolicy["models"];
      readonly enabledProviders?: readonly string[];
      readonly jev?: "on" | "off";
    }) => {
      configureCalls.push(Object.values(input.models));
      providerCalls.push(input.enabledProviders);
      jevCalls.push(input.jev);
      return {
        configPath: "/private/tandem/models.json",
        configured: true,
        models: input.models,
        enabledProviders: input.enabledProviders ?? enabledProviders,
      };
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  return { service, configureCalls, providerCalls, writeCalls, coordinatorMcpCalls, jevCalls };
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
  expect(fake.configureCalls[0]).toHaveLength(5);
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
  const prompts = [
    "Choose Keep all, Change roles, or Not now",
    "Use Jev?",
    "Save project settings?",
  ];
  const keys = ["\r", "\r", "\u001b[B\r"];
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
  expect(promptCalls).toHaveLength(2);
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

test("configure explains how to add a missing Jev key and saves turning Jev off", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const answers = ["keep all", "off"];
  const output: string[] = [];
  const result = await runTerminal(["configure", "--home", home], {
    cwd: repo,
    run: runCommand,
    service: fake.service,
    application: fakeApplication([]),
    prompt: async () => answers.shift() ?? "not now",
    processEnvironment: {},
    isTTY: true,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("configured");
  expect(output.join("")).toContain("export TYPESAFE_API_KEY=<your key>");
  expect(fake.jevCalls).toEqual(["off"]);
  await rm(join(repo, ".."), { recursive: true, force: true });
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
    "Presentations model selector",
    "Presentations thinking level",
    "Save these role choices?",
    "Use Jev?",
    "Save project settings?",
    "Let the coordinator use linear?",
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
    "\u001b[A\r",
    "\r",
    "\r",
    "\u001b[B\r",
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
      listMcpServers: async () => ["linear"],
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
    expect(fake.configureCalls[0]).toHaveLength(5);
    expect(
      fake.configureCalls[0]?.every(
        (model) => model.model === "test/model" && model.thinking === "low",
      ),
    ).toBe(true);
    expect(fake.writeCalls).toEqual([repo]);
    expect(fake.coordinatorMcpCalls).toEqual([["linear"]]);
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

test("reset cancels work in the current project, then launches fresh chats and attaches once", async () => {
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
  const forced: (boolean | undefined)[] = [];
  const output: string[] = [];
  const result = await runTerminal(["reset", "--yes", "--home", home], {
    cwd: first,
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
      forced.push(input.force);
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
  expect(forced).toEqual([true]);
  expect(events).toEqual(["reset", `launch:${first}`, "focus", "attach"]);
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.options.continueSession).toBe(false);
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
  const result = await runTerminal(["reset", "--yes", "--home", home], {
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

test("terminal commands are subcommands whose flags and arguments are checked", () => {
  expect(parseTerminalArgs([])).toMatchObject({ command: "launch", paths: [], fresh: false });
  expect(parseTerminalArgs(["/repo", "--fresh"])).toMatchObject({ paths: ["/repo"], fresh: true });
  expect(parseTerminalArgs(["update", "--fresh"])).toMatchObject({
    command: "update",
    fresh: true,
  });
  expect(parseTerminalArgs(["reset", "--hard", "--yes"])).toMatchObject({
    command: "reset",
    hard: true,
    yes: true,
  });
  expect(parseTerminalArgs(["status", "task-1", "--json"])).toMatchObject({
    command: "status",
    paths: ["task-1"],
    json: true,
  });
  expect(parseTerminalArgs(["--", "reset", "status"]).paths).toEqual(["reset", "status"]);
  expect(parseTerminalArgs(["/repo", "status"]).paths).toEqual(["/repo", "status"]);
  expect(() => parseTerminalArgs(["--hard"])).toThrow("tandem does not accept --hard");
  expect(() => parseTerminalArgs(["update", "/repo"])).toThrow("tandem update takes no arguments");
  expect(() => parseTerminalArgs(["status", "a", "b"])).toThrow("at most 1 argument");
  expect(() => parseTerminalArgs(["--bogus"])).toThrow("unknown option --bogus");
  expect(parseTerminalArgs(["watch", "--stop", "409"])).toMatchObject({
    command: "watch",
    paths: ["409"],
    stop: true,
  });
  expect(() => parseTerminalArgs(["status", "--stop"])).toThrow("does not accept --stop");
  expect(parseTerminalArgs(["status", "--watch", "--home", "/h"])).toMatchObject({
    command: "status",
    watch: true,
    home: "/h",
  });
  expect(() => parseTerminalArgs(["status", "--watch", "--json"])).toThrow(
    "tandem status --watch shows every project",
  );
  expect(() => parseTerminalArgs(["status", "task-1", "--watch"])).toThrow(
    "tandem status --watch shows every project",
  );
  expect(() => parseTerminalArgs(["watch", "--watch"])).toThrow("does not accept --watch");
  expect(parseTerminalArgs(["status", "--line"])).toMatchObject({ command: "status", line: true });
  for (const argv of [
    ["status", "--line", "--watch"],
    ["status", "--line", "--json"],
    ["status", "task-1", "--line"],
  ]) {
    expect(() => parseTerminalArgs(argv)).toThrow("tandem status --line is one line");
  }
  expect(() => parseTerminalArgs(["watch", "--line"])).toThrow("does not accept --line");
});

test("tandem status --line prints one line from saved state, for Herdr's tab bar", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-status-line-test-"));
  try {
    const output: string[] = [];
    const shown = await runTerminal(["status", "--line", "--home", home], {
      stdout: (text) => output.push(text),
    });
    expect(shown.exitCode).toBe(0);
    expect(output.join("")).toBe("✓ all quiet\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tandem watch starts watching a pull request named from this directory and prints the view", async () => {
  const started: unknown[] = [];
  const service = {
    prWatchStart: async (input: unknown) => {
      started.push(input);
      return { now: "2030-01-01T00:00:05.000Z", readAt: "2030-01-01T00:00:00.000Z", rows: [] };
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  const output: string[] = [];
  const result = await runTerminal(["watch", "409"], {
    cwd: "/repos/app",
    processEnvironment: { TANDEM_HOME: "/tmp/tandem-watch-test" },
    service,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result).toEqual({ exitCode: 0, status: "watch" });
  expect(started).toEqual([{ pullRequest: "409", repoPath: "/repos/app" }]);
  expect(output.join("")).toBe(
    "PR watch · 0 open · checked 5s ago\n\nNo pull requests are watched.\n",
  );
  expect((await runTerminal(["watch", "--stop"], { service, stderr: () => {} })).exitCode).toBe(1);
});

test("tandem status shows the board from saved state, and --json adds tasks with their IDs", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-status-test-"));
  const gitLog = async (request: CommandRequest): Promise<CommandResult> => ({
    code: request.argv[0] === "git" ? 0 : 1,
    stdout: "abc1234 feat: board\n",
    stderr: "",
  });
  let listed = 0;
  const service = {
    list: async () => {
      listed += 1;
      return [{ id: "task-1", stage: "implementing" }];
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  try {
    const output: string[] = [];
    const shown = await runTerminal(["status", "--home", home], {
      run: gitLog,
      service,
      stdout: (text) => output.push(text),
    });
    expect(shown.exitCode).toBe(0);
    expect(output.join("")).toStartWith(
      `Projects: none yet · PRs not checked yet\n\nNEEDS YOU ${"─".repeat(30)}\nNothing needs you.\n`,
    );
    expect(output.join("")).toContain("Tandem code: abc1234 feat: board");
    expect(listed).toBe(0);

    const json: string[] = [];
    await runTerminal(["status", "--json", "--home", home], {
      run: gitLog,
      service,
      stdout: (text) => json.push(text),
    });
    const parsed = JSON.parse(json.join(""));
    expect(parsed.tasks).toEqual([{ id: "task-1", stage: "implementing" }]);
    expect(parsed.board.needsYou).toEqual([]);
    expect(parsed.coordinators).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tandem trace prints one task's timeline, or the rollup across tasks", async () => {
  const rollup = { taskId: "task-1", firstPassReview: true, fixRounds: 0, blockedMs: 0 };
  const service = {
    trace: async (id: string) => ({
      events: [
        {
          seq: 1,
          taskId: id,
          at: "2030-01-01T00:00:00.000Z",
          type: "created",
          stage: "awaiting-approval",
        },
      ],
      unreadableEvents: 0,
      rollup,
    }),
    traceSummary: async () => ({
      tasks: 1,
      reviewedTasks: 1,
      firstPassReviews: 1,
      fixRounds: 0,
      blockedMs: 0,
      costMicros: 0,
      unpricedSamples: 0,
      rollups: [rollup],
    }),
    shutdown: async () => undefined,
  } as unknown as TandemService;
  const run = async (argv: readonly string[]) => {
    const output: string[] = [];
    const result = await runTerminal(argv, {
      processEnvironment: { TANDEM_HOME: "/tmp/tandem-trace-test" },
      service,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    return { result, text: output.join("") };
  };

  const one = await run(["trace", "task-1"]);
  expect(one.result).toEqual({ exitCode: 0, status: "trace" });
  expect(one.text).toContain("2030-01-01T00:00:00.000Z  created at awaiting-approval");
  expect(one.text).toContain("First review: passed");
  expect(JSON.parse((await run(["trace", "task-1", "--json"])).text).rollup).toEqual(rollup);
  expect((await run(["trace"])).text).toContain("First-pass review rate: 100% (1 of 1)");
  expect(() => parseTerminalArgs(["trace", "a", "b"])).toThrow("at most 1 argument");
});

test("tandem report writes the page, opens it in Lavish, and falls back to the path", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-report-test-"));
  try {
    const reportCalls: unknown[] = [];
    const service = {
      report: async (options: unknown) => {
        reportCalls.push(options);
        return {
          schemaVersion: 1,
          generatedAt: "2030-01-02T03:04:05.678Z",
          scopeLabel: "tandem",
          tasks: [],
          unreadableEvents: 0,
        };
      },
      shutdown: async () => undefined,
    } as unknown as TandemService;
    const commands: CommandRequest[] = [];
    let lavish: CommandResult = {
      code: 0,
      stdout: "session:\n  status: opened\n",
      stderr: "",
    };
    const run = async (argv: readonly string[]) => {
      const output: string[] = [];
      const result = await runTerminal(argv, {
        processEnvironment: { TANDEM_HOME: home },
        service,
        run: async (request) => {
          commands.push(request);
          return lavish;
        },
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      });
      return { result, text: output.join("") };
    };
    const path = join(home, "reports", "report-2030-01-02T03-04-05-678Z.html");

    const opened = await run(["report", "--since", "2030-01-01T00:00:00Z"]);
    expect(opened.result).toEqual({ exitCode: 0, status: "report" });
    expect(opened.text).toBe(`Report opened in Lavish: ${path}\n`);
    expect(reportCalls).toEqual([{ since: "2030-01-01T00:00:00.000Z" }]);
    expect(commands.map((request) => request.argv)).toEqual([["lavish-axi", path]]);
    expect(existsSync(path)).toBe(true);

    lavish = { code: 1, stdout: "error: no browser\ncode: INTERNAL\n", stderr: "" };
    const failed = await run(["report"]);
    expect(failed.result.exitCode).toBe(0);
    expect(failed.text).toContain(`Report written: ${path}\nLavish could not open it`);

    commands.length = 0;
    expect((await run(["report", "--no-open"])).text).toBe(`Report written: ${path}\n`);
    await rm(join(home, "reports"), { recursive: true, force: true });
    const json = await run(["report", "--json"]);
    expect(JSON.parse(json.text).scopeLabel).toBe("tandem");
    expect(commands).toEqual([]);
    expect(existsSync(join(home, "reports"))).toBe(false);

    const invalid = await run(["report", "--since", "last week"]);
    expect(invalid.result.exitCode).toBe(1);
    expect(invalid.text).toContain("--since needs a date like 2030-01-31");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("report --since takes a local calendar day or a zoned timestamp, and only on report", () => {
  expect(parseTerminalArgs(["report", "--since", "2030-01-31"]).since).toBe(
    new Date(2030, 0, 31).toISOString(),
  );
  expect(parseTerminalArgs(["report", "--since=2030-01-31T09:30:00+02:00"]).since).toBe(
    "2030-01-31T07:30:00.000Z",
  );
  expect(parseTerminalArgs(["report"]).since).toBeUndefined();
  expect(() => parseReportSince("2030-02-30")).toThrow("--since needs a date");
  expect(() => parseReportSince("2030-01-31T09:30")).toThrow("--since needs a date");
  expect(() => parseTerminalArgs(["report", "--since"])).toThrow("--since requires");
  expect(() => parseTerminalArgs(["trace", "--since", "2030-01-31"])).toThrow(
    "tandem trace does not accept --since",
  );
  expect(() => parseTerminalArgs(["status", "--no-open"])).toThrow("does not accept --no-open");
  expect(() => parseTerminalArgs(["report", "task-1"])).toThrow("takes no arguments");
});

test("old command spellings name their replacement instead of opening a project", () => {
  expect(() => parseTerminalArgs(["restart"])).toThrow("`tandem restart` is now `tandem update`");
  expect(() => parseTerminalArgs(["--reset", "--force"])).toThrow("is now `tandem reset`");
  expect(() => parseTerminalArgs(["reconcile-resources"])).toThrow("is now `tandem fix`");
  expect(() => parseTerminalArgs(["logs"])).toThrow("is now `tandem status --logs`");
  expect(() => parseTerminalArgs(["inspect", "task-1"])).toThrow("tandem status TASK_ID");
  expect(() => parseTerminalArgs(["board"])).toThrow("is now `tandem status --watch`");
  expect(parseTerminalArgs(["--", "restart"]).paths).toEqual(["restart"]);
});

test("status --logs prints recent prompt-routing events without launching a project", async () => {
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
    expect(parseTerminalArgs(["status", "--logs", "--home", home])).toMatchObject({
      command: "status",
      logs: true,
      paths: [],
      home,
    });
    const output: string[] = [];
    const result = await runTerminal(["status", "--logs", "--home", home], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "status" });
    expect(output.join("")).toContain(`Tandem prompt-routing log: ${logPath}`);
    expect(output.join("")).toContain("prompt-route-evaluated");
    expect(output.join("")).toContain("prompt-route-dispatched");
    expect(output.join("")).not.toContain("worker-event");

    const jsonOutput: string[] = [];
    await runTerminal(["status", "--logs", "--home", home, "--json"], {
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

test("fix inspects Tandem resources and applies nothing when there is nothing to clean", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-reconcile-test-"));
  try {
    expect(parseTerminalArgs(["fix", "--home", home])).toMatchObject({
      command: "fix",
      paths: [],
      home,
      yes: false,
    });
    expect(() => parseTerminalArgs(["fix", "/repo"])).toThrow("tandem fix takes no arguments");
    expect(parseTerminalArgs(["fix", "--verbose"])).toMatchObject({ verbose: true });
    expect(() => parseTerminalArgs(["status", "--verbose"])).toThrow(
      "tandem status does not accept --verbose",
    );

    const run = async (request: CommandRequest): Promise<CommandResult> => {
      throw new Error(`an empty Tandem home needs no commands: ${request.argv.join(" ")}`);
    };
    const output: string[] = [];
    const result = await runTerminal(["fix", "--home", home], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      run,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "fixed" });
    expect(output.join("")).toBe("Tandem fix · nothing to clean up\n");

    const jsonOutput: string[] = [];
    await runTerminal(["fix", "--home", home, "--json"], {
      cwd: home,
      processEnvironment: {},
      isTTY: false,
      run,
      stdout: (text) => jsonOutput.push(text),
      stderr: (text) => jsonOutput.push(text),
    });
    expect(JSON.parse(jsonOutput.join(""))).toMatchObject({
      schemaVersion: 2,
      mode: "dry-run",
      cleaned: [],
      retained: [],
      quarantined: [],
      failed: [],
      freeable: [],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a reset refusal prevents every coordinator launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  let resetCalls = 0;
  const result = await runTerminal(["reset", "--yes", "--home", home, "--headless"], {
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

test("update refuses only from the coordinator pane it would close", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const root = join(repo, "..");
  const home = join(root, "home");
  const worktreeRoot = join(root, "pool");
  const worktreePath = join(worktreeRoot, "coordinator");
  await mkdir(worktreePath, { recursive: true });
  await saveCoordinatorRecord(home, {
    schemaVersion: 1,
    repoPath: repo,
    endpoint: {
      sessionId: "tandem",
      workspaceId: "workspace-coordinator",
      tabId: "tab-coordinator",
      paneId: "pane-coordinator",
      role: "coordinator",
      generation: 0,
    },
    worktree: {
      root: worktreeRoot,
      path: worktreePath,
      name: "coordinator",
      baseHead: "abc123",
      branch: "tandem/coordinator",
      leaseId: "lease-coordinator",
      leaseHolder: "coordinator",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    command: ["omp"],
  });
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const inPane = (paneId: string) =>
    runTerminal(["update", "--home", home], {
      cwd: repo,
      processEnvironment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "tandem",
        HERDR_WORKSPACE_ID: "workspace-coordinator",
        HERDR_PANE_ID: paneId,
      },
      run: async (request) =>
        request.argv[0] === "herdr" ? { code: 0, stdout: "", stderr: "" } : runCommand(request),
      service: fake.service,
      application: fakeApplication(invocations),
      isTTY: false,
      stdout: () => undefined,
      stderr: () => undefined,
    });

  const refused = await inPane("pane-coordinator");
  expect(refused.status).toBe("error");
  expect(refused.error?.message).toContain("would close the coordinator pane");
  expect(invocations).toHaveLength(0);

  const updated = await inPane("pane-other");
  expect(updated.status).toBe("launched");
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.options).toMatchObject({ restart: true, continueSession: true });
  await rm(root, { recursive: true, force: true });
});

test("reset without a terminal needs --yes and changes nothing", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const result = await runTerminal(["reset", "--home", home], {
    cwd: repo,
    processEnvironment: {},
    run: runCommand,
    service: fake.service,
    application: fakeApplication(invocations),
    resetCoordinators: async () => {
      throw new Error("reset should not run without confirmation");
    },
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("--yes");
  expect(invocations).toHaveLength(0);
  await rm(join(repo, ".."), { recursive: true, force: true });
});

test("reset --hard stops Tandem, then deletes its home, pool, and remembered setup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-hard-reset-")));
  const home = join(root, "home");
  const pool = join(root, "pool");
  const config = join(root, "config");
  await mkdir(join(home, "repositories"), { recursive: true });
  await mkdir(pool, { recursive: true });
  await mkdir(join(config, "tandem"), { recursive: true });
  await writeFile(join(home, "state.sqlite"), "");
  await writeFile(
    join(config, "tandem", "config.json"),
    JSON.stringify({ schemaVersion: 1, home, sessionId: "tandem" }),
  );
  const stops: (boolean | undefined)[] = [];
  const output: string[] = [];
  try {
    const result = await runTerminal(["reset", "--hard", "--yes"], {
      cwd: root,
      processEnvironment: { XDG_CONFIG_HOME: config, TANDEM_POOL_ROOT: pool },
      run: runCommand,
      resetCoordinators: async (_run, input) => {
        stops.push(input.force);
        throw new Error("state is too broken to stop cleanly");
      },
      isTTY: false,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    expect(result.status).toBe("reset");
    expect(stops).toEqual([true]);
    expect(output.join("")).toContain("Close any leftover Tandem panes");
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(config, "tandem", "config.json"))).toBe(false);
    expect(existsSync(pool)).toBe(false);
    expect(existsSync(join(config, "tandem"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("saved projects are found from settings.toml as well as legacy config.json", async () => {
  const projects = await gitProjects(2);
  const [tomlProject, legacyProject] = projects;
  if (tomlProject === undefined || legacyProject === undefined) {
    throw new Error("test projects were not created");
  }
  const home = join(tomlProject, "..", "home");
  await registerProjects(home, [legacyProject]);
  await onboardRepo({ repoPath: tomlProject, home, write: true });
  expect(await readRegisteredProjects(home)).toEqual([...projects].sort());
  await rm(join(tomlProject, ".."), { recursive: true, force: true });
});

test("update puts task workspaces back under the replacement coordinator", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const root = join(repo, "..");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await saveCoordinator(home, repo, "w-old");
  await seedTasks(home, [{ id: "36a4f150-task", repoPath: repo, workspaceId: "w-task" }]);
  const sidebar = fakeSidebar(["w-old", "w-task"]);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const application: CliApplication = {
    // The replacement coordinator's workspace lands at the end, as Herdr does on create.
    invoke: async (invocation) => {
      await saveCoordinator(home, repo, "w-new");
      sidebar.order.splice(sidebar.order.indexOf("w-old"), 1);
      sidebar.order.push("w-new");
      return { command: invocation.command, value: { workspaceId: "w-new" } };
    },
    shutdown: async () => undefined,
  };
  const result = await runTerminal(["update", "--home", home], {
    cwd: repo,
    processEnvironment: {},
    run: (request) => (request.argv[0] === "herdr" ? sidebar.run(request) : runCommand(request)),
    moveWorkspace: sidebar.moveWorkspace,
    service: fake.service,
    application,
    isTTY: false,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(result.status).toBe("launched");
  expect(sidebar.order).toEqual(["w-new", "w-task"]);
  await rm(root, { recursive: true, force: true });
});

test("update re-nests before attaching to Herdr and prints every re-nest warning", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const root = join(repo, "..");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await saveCoordinator(home, repo, "w-old");
  await seedTasks(home, [{ id: "36a4f150-task", repoPath: repo, workspaceId: "w-task" }]);
  const sidebar = fakeSidebar(["w-old", "w-task"]);
  const fake = onboardingService({ existingConfig: true, configured: true });
  const hookWarning = "could not read Tandem's task records: lock busy";
  const application: CliApplication = {
    invoke: async (invocation) => {
      await saveCoordinator(home, repo, "w-new");
      sidebar.order.splice(sidebar.order.indexOf("w-old"), 1);
      sidebar.order.push("w-new");
      return {
        command: invocation.command,
        value: { workspaceId: "w-new", renestWarnings: [hookWarning] },
      };
    },
    shutdown: async () => undefined,
  };
  let orderWhenAttached: readonly string[] = [];
  const output: string[] = [];
  const result = await runTerminal(["update", "--home", home], {
    cwd: repo,
    processEnvironment: {},
    run: (request) =>
      request.argv[0] !== "herdr"
        ? runCommand(request)
        : request.argv.includes("focus")
          ? Promise.resolve({ code: 0, stdout: "", stderr: "" })
          : sidebar.run(request),
    moveWorkspace: sidebar.moveWorkspace,
    service: fake.service,
    application,
    isTTY: true,
    // Attaching blocks until the person leaves Herdr, so the sidebar must already be right.
    runInteractive: async () => {
      orderWhenAttached = [...sidebar.order];
      return 0;
    },
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(result.status).toBe("launched");
  expect(orderWhenAttached).toEqual(["w-new", "w-task"]);
  expect(output.join("")).toContain(
    `Tandem left some task workspaces where they were: ${hookWarning}\n`,
  );
  await rm(root, { recursive: true, force: true });
});

test("fix re-nests task workspaces without asking, and says so in text and JSON", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const root = join(repo, "..");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await saveCoordinator(home, repo, "w-coordinator");
  await seedTasks(home, [{ id: "36a4f150-task", repoPath: repo, workspaceId: "w-task" }]);
  const run = (sidebar: ReturnType<typeof fakeSidebar>) => async (request: CommandRequest) =>
    request.argv[0] === "herdr" && ["status", "workspace"].includes(request.argv[3] ?? "")
      ? sidebar.run(request)
      : { code: 1, stdout: "", stderr: "not available in this test" };
  const fix = async (sidebar: ReturnType<typeof fakeSidebar>, ...flags: string[]) => {
    const output: string[] = [];
    await runTerminal(["fix", "--home", home, ...flags], {
      cwd: root,
      processEnvironment: {},
      isTTY: false,
      run: run(sidebar),
      moveWorkspace: sidebar.moveWorkspace,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    return output.join("");
  };

  const text = fakeSidebar(["w-task", "w-coordinator"]);
  expect(await fix(text)).toContain(
    `Re-nested (1) · moved TAG-1036 workers under ${basename(repo)}'s coordinator\n`,
  );
  expect(text.order).toEqual(["w-coordinator", "w-task"]);

  const json = fakeSidebar(["w-task", "w-coordinator"]);
  const report = JSON.parse(await fix(json, "--json"));
  expect(report.renest).toMatchObject({ moved: 1, warnings: [] });
  expect(report.renest.planned).toEqual([
    expect.objectContaining({ taskId: "36a4f150-task", workspaceId: "w-task" }),
  ]);
  await rm(root, { recursive: true, force: true });
});
