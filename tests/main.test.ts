import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { OmpModelRecord } from "../src/adapters.ts";
import type { CliApplication, CliInvocation } from "../src/cli.ts";
import { runCommand } from "../src/commands.ts";
import type { CommandRequest, CommandResult, ModelSpec, RepoPolicy } from "../src/contracts.ts";
import { runTerminal } from "../src/main.ts";
import type { TandemService } from "../src/service.ts";

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

function onboardingService(options: Readonly<{ existingConfig: boolean; configured: boolean }>): {
  readonly service: TandemService;
  readonly configureCalls: ModelSpec[][];
  readonly writeCalls: string[];
} {
  const configureCalls: ModelSpec[][] = [];
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
        ...(models === undefined ? {} : { models }),
      },
      availableModels: catalogue(),
    }),
    configureModels: async (input: { readonly models: RepoPolicy["models"] }) => {
      configureCalls.push(Object.values(input.models));
      return { configPath: "/private/tandem/models.json", configured: true, models: input.models };
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  return { service, configureCalls, writeCalls };
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
  const answers = roles.flatMap(() => ["test/model", "low"]);
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

test("unsupported thinking cancels before any model write or coordinator launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = ["test/model", "max", "not now"];
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
  const answers = roles.flatMap(() => ["test/model", "high"]);
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

test("the visible Save settings choice writes the central project record before launch", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: false, configured: true });
  const invocations: CliInvocation[] = [];
  const answers = ["keep all", "save settings"];
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
  expect(fake.writeCalls).toEqual([repo]);
  expect(invocations).toHaveLength(1);
  await rm(join(repo, ".."), { recursive: true, force: true });
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
    return runCommand(request);
  };
  const fake = onboardingService({ existingConfig: true, configured: true });
  const invocations: CliInvocation[] = [];
  const interactiveCalls: CommandRequest[] = [];
  const result = await runTerminal([repo, "--home", home], {
    cwd: repo,
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
    return runCommand(request);
  };
  const result = await runTerminal(["--home", home], {
    cwd,
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
  expect(invocations.map((invocation) => invocation.options.sessionId)).toEqual([
    "tandem",
    "tandem",
  ]);
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

test("bare launch with an empty registry keeps current-Git onboarding", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const home = join(repo, "..", "home");
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const answers = roles.flatMap(() => ["test/model", "low"]);
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

test("readline onboarding releases terminal input before Herdr attachment", async () => {
  const [repo] = await gitProjects(1);
  if (repo === undefined) throw new Error("test project was not created");
  const parent = join(repo, "..");
  const home = join(parent, "home");
  const { input, output } = ttyStreams();
  const fake = onboardingService({ existingConfig: true, configured: false });
  const invocations: CliInvocation[] = [];
  const promptMarkers = [
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
  ] as const;
  const answers = roles.flatMap(() => ["test/model", "low"]);
  answers.push("save");
  let rendered = "";
  let nextAnswer = 0;
  let childInput = "";
  const onOutput = (chunk: Buffer | string): void => {
    rendered += chunk.toString();
    while (nextAnswer < promptMarkers.length) {
      const marker = promptMarkers[nextAnswer];
      const answer = answers[nextAnswer];
      if (marker === undefined || answer === undefined || !rendered.includes(marker)) break;
      nextAnswer += 1;
      queueMicrotask(() => {
        input.write(`${answer}\n`);
      });
    }
  };
  output.on("data", onOutput);
  try {
    const result = await runTerminal([repo, "--home", home], {
      cwd: repo,
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
    expect(invocations).toHaveLength(1);
    expect(nextAnswer).toBe(promptMarkers.length);
    expect(promptMarkers.every((marker) => rendered.includes(marker))).toBe(true);
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
  expect(invocations[0]?.options.continueSession).toBe(false);
  expect(output.join("")).toContain("Tandem reset stopped 0 coordinators.");
  await rm(join(first, ".."), { recursive: true, force: true });
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
  await rm(join(repo, ".."), { recursive: true, force: true });
});
