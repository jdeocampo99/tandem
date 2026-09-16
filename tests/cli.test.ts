import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCoordinatorArgv,
  type CliApplication,
  type CliDependencies,
  type CoordinatorLaunchRequest,
  createCliApplication,
  launchCoordinator,
  parseCliArgs,
  runCli,
} from "../src/cli.ts";
import { quoteShellArgument, runCommand } from "../src/commands.ts";
import type { TaskRecord } from "../src/contracts.ts";
import { defaultPolicy } from "../src/policy.ts";
import { createTandemService, type TandemService } from "../src/service.ts";

async function writeOmpProbe(root: string, exitCode = 0): Promise<string> {
  const outputPath = join(root, "omp-probe-output.txt");
  const script = `#!/bin/sh
{
  printf 'AUTH_TOKEN=%s\n' "$AUTH_TOKEN"
  printf 'HERDR_ENV=%s\n' "$HERDR_ENV"
  printf 'HERDR_SESSION=%s\n' "$HERDR_SESSION"
  printf 'HERDR_WORKSPACE_ID=%s\n' "$HERDR_WORKSPACE_ID"
  printf 'HERDR_PANE_ID=%s\n' "$HERDR_PANE_ID"
  printf 'TANDEM_HOME=%s\n' "$TANDEM_HOME"
  printf 'TANDEM_POOL_ROOT=%s\n' "$TANDEM_POOL_ROOT"
  printf 'TANDEM_SESSION=%s\n' "$TANDEM_SESSION"
  printf 'TANDEM_REPO=%s\n' "$TANDEM_REPO"
  printf 'TANDEM_PARENT_WORKSPACE=%s\n' "$TANDEM_PARENT_WORKSPACE"
  index=0
  for arg in "$@"; do
    printf 'ARG_%s=%s\n' "$index" "$arg"
    index=$((index + 1))
  done
} > ${quoteShellArgument(outputPath)}
exit ${exitCode}
`;
  const probePath = join(root, "omp");
  await writeFile(probePath, script, "utf8");
  await chmod(probePath, 0o755);
  return outputPath;
}

let processEnvironmentTail: Promise<void> = Promise.resolve();

async function withProcessEnvironment<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  action: () => Promise<T>,
): Promise<T> {
  const previousTail = processEnvironmentTail;
  let release!: () => void;
  processEnvironmentTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousTail;
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    release();
  }
}

function cancelledTask(): TaskRecord {
  const policy = defaultPolicy();
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath: "/repo",
    kind: "scout",
    objective: "cleanup test",
    acceptanceCriteria: ["cleanup completes"],
    surfaces: ["cli"],
    stage: "cancelled",
    scopeApproved: false,
    policy: {
      config: policy,
      guidance: { implementation: [], validation: [], review: [] },
    },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    generation: 0,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
  };
}

test("parseCliArgs keeps PR commands explicit and records consent separately", () => {
  const invocation = parseCliArgs([
    "pr",
    "publish",
    "task-1",
    "org/repo",
    "Reviewed change",
    "main",
    '{"tldr":["safe"],"what":["changed"],"why":["needed"]}',
    "--yes",
    "--json",
  ]);

  expect(invocation.command).toBe("publish");
  expect(invocation.positionals).toEqual([
    "task-1",
    "org/repo",
    "Reviewed change",
    "main",
    '{"tldr":["safe"],"what":["changed"],"why":["needed"]}',
  ]);
  expect(invocation.options.yes).toBe(true);
  expect(invocation.options.json).toBe(true);
});

test("communication CLI syntax keeps repeatable supersedes and exact answer fields", () => {
  const steer = parseCliArgs([
    "steer",
    "--task",
    "task-1",
    "--text",
    "Preserve the public API",
    "--supersedes",
    "message-1",
    "--supersedes=message-2",
    "--json",
  ]);
  expect(steer.command).toBe("steer");
  expect(steer.positionals).toEqual([]);
  expect(steer.options.taskId).toBe("task-1");
  expect(steer.options.text).toBe("Preserve the public API");
  expect(steer.options.supersedes).toEqual(["message-1", "message-2"]);

  const answer = parseCliArgs([
    "answer",
    "--task",
    "task-1",
    "--question",
    "question-1",
    "--text",
    "Use the existing adapter",
  ]);
  expect(answer.command).toBe("answer");
  expect(answer.options.questionId).toBe("question-1");
  expect(answer.options.text).toBe("Use the existing adapter");
  expect(() => parseCliArgs(["messages", "task-1"])).toThrow("accepts at most");
});

test("buildCoordinatorArgv disables discovery and exposes only coordinator read/interview plus Tandem", () => {
  const argv = buildCoordinatorArgv({
    cwd: "/repo",
    model: { model: "openai-codex/gpt-6-astra", thinking: "high" },
    configPath: "/tandem/src/worker-config.yml",
    extensionPath: "/tandem/src/extension.ts",
    continueSession: true,
  });

  expect(argv).toContain("--no-extensions");
  expect(argv).toContain("--extension");
  expect(argv).toContain("/tandem/src/extension.ts");
  expect(argv).toContain("--config");
  expect(argv).toContain("/tandem/src/worker-config.yml");
  expect(argv).toContain("--tools");
  expect(argv).toContain("read,grep,glob,ask,tandem");
  expect(argv).toContain("--continue");
  expect(argv).not.toContain("--no-session");
  expect(argv).not.toContain("write");
  expect(argv).not.toContain("bash");
  expect(argv).not.toContain("eval");
});

test("CLI approval refusal fails closed and never reaches the service", async () => {
  let serviceCreated = false;
  const dependencies: CliDependencies = {
    processEnvironment: { TANDEM_HOME: "/tmp/tandem", TANDEM_REPO: "/repo" },
    stdout: () => undefined,
    stderr: () => undefined,
    createService: () => {
      serviceCreated = true;
      throw new Error("service must not be created for a refused action");
    },
  };
  const stderr: string[] = [];
  const result = await runCli(["approve", "task-1", "--json"], {
    ...dependencies,
    stderr: (value) => stderr.push(value),
  });

  expect(result.exitCode).toBe(2);
  expect(result.error?.name).toBe("CliConsentError");
  expect(serviceCreated).toBe(false);
  expect(JSON.parse(stderr.join(""))).toMatchObject({ error: { name: "CliConsentError" } });
});
test("configure-models refuses before reading input or constructing a service without --yes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-configure-consent-"));
  let serviceCreated = false;
  try {
    const result = await runCli(
      [
        "configure-models",
        "--repo",
        join(root, "repo"),
        "--home",
        join(root, "home"),
        "--input",
        join(root, "missing.json"),
        "--json",
      ],
      {
        cwd: root,
        processEnvironment: {},
        createService: () => {
          serviceCreated = true;
          throw new Error("refused configure must not construct a service");
        },
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.error?.name).toBe("CliConsentError");
    expect(serviceCreated).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configure-models reads a direct six-role file and passes it to the approved service", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-configure-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    const inputPath = join(root, "model-selection.json");
    await mkdir(repo, { recursive: true });
    const models = {
      coordinator: { model: "test/coordinator", thinking: "high" },
      scout: { model: "test/scout", thinking: "low" },
      implementer: { model: "test/implementer", thinking: "max" },
      reviewer: { model: "test/reviewer", thinking: "max" },
      verifier: { model: "test/verifier", thinking: "high" },
      presentation: { model: "test/presentation", thinking: "low" },
    } as const;
    await writeFile(inputPath, `${JSON.stringify(models)}\n`, "utf8");
    type ConfigureInput = Readonly<{
      readonly repoPath: string;
      readonly models: typeof models;
    }>;
    let received: ConfigureInput | undefined;
    const settings = {
      configPath: join(home, "home-models.json"),
      configured: true,
      models,
    };
    const service = {
      configureModels: async (input: ConfigureInput) => {
        received = input;
        return settings;
      },
      shutdown: async () => undefined,
    } as unknown as TandemService;
    const stdout: string[] = [];
    const result = await runCli(
      ["configure-models", "--repo", repo, "--home", home, "--input", inputPath, "--yes", "--json"],
      {
        cwd: root,
        processEnvironment: {},
        createService: () => service,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(received).toEqual({ repoPath: repo, models });
    expect(JSON.parse(stdout.join(""))).toEqual(settings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI preserves trailing-space repository and home paths for central setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-central-policy-"));
  let application: CliApplication | undefined;
  try {
    const ordinaryRepo = join(root, "repo");
    const requestedRepo = join(root, "repo ");
    const home = join(root, "tandem-home ");
    await mkdir(ordinaryRepo, { recursive: true });
    await mkdir(requestedRepo, { recursive: true });
    application = createCliApplication({
      cwd: root,
      processEnvironment: {},
    });

    const result = await application.invoke(
      parseCliArgs(["setup", "--repo", requestedRepo, "--home", home, "--yes"]),
    );
    const setup = result.value as {
      readonly configPath: string;
      readonly repoPath: string;
    };
    const envelope = JSON.parse(await readFile(setup.configPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(result.approved).toBe(true);
    expect(setup.repoPath).toBe(await realpath(requestedRepo));
    expect(setup.configPath).toContain(join("tandem-home ", "repositories"));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      repoPath: setup.repoPath,
      policy: { version: 1, validationCommands: [] },
    });
    await expect(readFile(join(requestedRepo, ".tandem.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(ordinaryRepo, ".tandem.json"), "utf8")).rejects.toThrow();
  } finally {
    await application?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI launch exposes resolved environment and session isolation to a real coordinator child", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-launch-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    await mkdir(repo, { recursive: true });
    const outputPath = await writeOmpProbe(root);
    const model = defaultPolicy().models.coordinator;
    const application = createCliApplication({
      cwd: root,
      service: createTandemService({ home, poolRoot, sessionId: "tandem-session" }),
      processEnvironment: {
        AUTH_TOKEN: "preserve-me",
        HERDR_ENV: "1",
        HERDR_SESSION: "tandem-session",
        HERDR_WORKSPACE_ID: "workspace-1",
        HERDR_PANE_ID: "pane-1",
      },
      statPath: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({
          models: [
            {
              selector: model.model,
              id: "model-id",
              provider: "openai",
              thinking: [model.thinking],
            },
          ],
        }),
        stderr: "",
      }),
      startPersistent: async () => {
        throw new Error("must not start a second Herdr session in the owned pane");
      },
    });
    const path = `${root}:/usr/bin:/bin`;
    const result = await withProcessEnvironment(
      {
        AUTH_TOKEN: "preserve-me",
        HERDR_ENV: undefined,
        HERDR_SESSION: undefined,
        HERDR_SESSION_NAME: undefined,
        HERDR_WORKSPACE_ID: undefined,
        HERDR_PANE_ID: undefined,
        PATH: path,
      },
      () =>
        application.invoke(
          parseCliArgs([
            "launch",
            "--home",
            home,
            "--pool-root",
            poolRoot,
            "--session",
            "tandem-session",
            "--repo",
            repo,
            "--parent-workspace",
            "explicit-parent",
            "--continue",
          ]),
        ),
    );
    expect(result.command).toBe("launch");
    expect(result.value).toMatchObject({
      direct: true,
      workspaceId: "workspace-1",
      paneId: "pane-1",
    });
    const observed = await readFile(outputPath, "utf8");
    expect(observed).toContain("AUTH_TOKEN=preserve-me\n");
    expect(observed).toContain("HERDR_ENV=1\n");
    expect(observed).toContain("HERDR_SESSION=tandem-session\n");
    expect(observed).toContain("HERDR_WORKSPACE_ID=workspace-1\n");
    expect(observed).toContain("HERDR_PANE_ID=pane-1\n");
    expect(observed).toContain(`TANDEM_HOME=${home}\n`);
    expect(observed).toContain(`TANDEM_POOL_ROOT=${poolRoot}\n`);
    expect(observed).toContain("TANDEM_SESSION=tandem-session\n");
    expect(observed).toContain(`TANDEM_REPO=${repo}\n`);
    expect(observed).toContain("TANDEM_PARENT_WORKSPACE=explicit-parent\n");
    const sessionArgument = observed
      .split("\n")
      .find((line) => line.startsWith("ARG_") && line.includes("/coordinator-sessions/"));
    expect(sessionArgument).toContain(`${home}/coordinator-sessions/`);
    expect(sessionArgument).toMatch(/[a-f0-9]{24}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reports a failed direct coordinator child as a nonzero outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-failed-launch-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    await mkdir(repo, { recursive: true });
    const outputPath = await writeOmpProbe(root, 7);
    const model = defaultPolicy().models.coordinator;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const path = `${root}:/usr/bin:/bin`;
    const result = await withProcessEnvironment(
      {
        AUTH_TOKEN: "preserve-me",
        HERDR_ENV: "1",
        HERDR_SESSION: "tandem-session",
        HERDR_WORKSPACE_ID: "workspace-1",
        HERDR_PANE_ID: "pane-1",
        PATH: path,
      },
      () =>
        runCli(
          [
            "launch",
            "--home",
            home,
            "--pool-root",
            poolRoot,
            "--session",
            "tandem-session",
            "--repo",
            repo,
            "--continue",
            "--json",
          ],
          {
            cwd: root,
            service: createTandemService({ home, poolRoot, sessionId: "tandem-session" }),
            processEnvironment: {
              AUTH_TOKEN: "preserve-me",
              HERDR_ENV: "1",
              HERDR_SESSION: "tandem-session",
              HERDR_WORKSPACE_ID: "workspace-1",
              HERDR_PANE_ID: "pane-1",
            },
            statPath: async () => ({
              isFile: () => true,
              isSymbolicLink: () => false,
            }),
            run: async () => ({
              code: 0,
              stdout: JSON.stringify({
                models: [
                  {
                    selector: model.model,
                    id: "model-id",
                    provider: "openai",
                    thinking: [model.thinking],
                  },
                ],
              }),
              stderr: "",
            }),
            stdout: (value) => stdout.push(value),
            stderr: (value) => stderr.push(value),
          },
        ),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.error?.message).toContain("coordinator exited with code 7");
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      error: { message: "coordinator exited with code 7" },
    });
    expect(await readFile(outputPath, "utf8")).toContain("TANDEM_SESSION=tandem-session\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchCoordinator executes the generated quoted command in a new Herdr pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-pane-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator home");
    const poolRoot = join(root, "coordinator pool");
    await mkdir(repo, { recursive: true });
    const outputPath = await writeOmpProbe(root);
    const request: CoordinatorLaunchRequest = {
      cwd: repo,
      repo,
      home,
      poolRoot,
      sessionId: "pane-session",
      model: { model: "openai-codex/gpt-6-astra", thinking: "high" },
      configPath: "/tandem/src/worker-config.yml",
      extensionPath: "/tandem/src/extension.ts",
      continueSession: true,
      headless: true,
      noAttach: false,
      parentWorkspaceId: "explicit-parent",
    };
    const path = `${root}:/usr/bin:/bin`;
    const herdrEnvironment = {
      HERDR_ENV: "1",
      HERDR_SESSION: "herdr-session",
      HERDR_WORKSPACE_ID: "herdr-workspace",
      HERDR_PANE_ID: "herdr-pane",
    } as const;
    const result = await withProcessEnvironment(
      {
        AUTH_TOKEN: "preserve-me",
        PATH: path,
      },
      () =>
        launchCoordinator(request, {
          run: async (command) => {
            if (command.argv.includes("status")) {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (command.argv.includes("workspace") && command.argv.includes("create")) {
              return {
                code: 0,
                stdout: JSON.stringify({
                  result: {
                    workspace: { workspace_id: "workspace-2" },
                    root_pane: { pane_id: "pane-2" },
                  },
                }),
                stderr: "",
              };
            }
            if (command.argv.includes("pane") && command.argv.includes("run")) {
              const shellCommand = command.argv.at(-1);
              if (shellCommand === undefined)
                throw new Error("pane run command omitted generated shell command");
              return runCommand({
                argv: ["/bin/sh", "-c", shellCommand],
                cwd: command.cwd,
                env: { ...(command.env ?? {}), ...herdrEnvironment },
              });
            }
            throw new Error(`unexpected Herdr command: ${command.argv.join(" ")}`);
          },
          startPersistent: async () => undefined,
          runInteractive: async () => {
            throw new Error("new-pane launch must not start OMP in the parent process");
          },
          sleep: async () => undefined,
          processEnvironment: { AUTH_TOKEN: "preserve-me" },
        }),
    );

    expect(result.direct).toBe(false);
    expect(result.workspaceId).toBe("workspace-2");
    expect(result.paneId).toBe("pane-2");
    const observed = await readFile(outputPath, "utf8");
    expect(observed).toContain("HERDR_SESSION=herdr-session\n");
    expect(observed).toContain("AUTH_TOKEN=preserve-me\n");
    expect(observed).toContain("HERDR_ENV=1\n");
    expect(observed).toContain("HERDR_WORKSPACE_ID=herdr-workspace\n");
    expect(observed).toContain("HERDR_PANE_ID=herdr-pane\n");
    expect(observed).toContain(`TANDEM_HOME=${home}\n`);
    expect(observed).toContain(`TANDEM_POOL_ROOT=${poolRoot}\n`);
    expect(observed).toContain("TANDEM_SESSION=pane-session\n");
    expect(observed).toContain(`TANDEM_REPO=${repo}\n`);
    expect(observed).toContain("TANDEM_PARENT_WORKSPACE=explicit-parent\n");
    const sessionArgument = observed
      .split("\n")
      .find((line) => line.startsWith("ARG_") && line.includes("/coordinator-sessions/"));
    expect(sessionArgument).toContain(`${home}/coordinator-sessions/`);
    expect(sessionArgument).toMatch(/[a-f0-9]{24}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe cleanup is hands-off while destructive discard still requires --yes", async () => {
  const cleanupInputs: unknown[] = [];
  const task = cancelledTask();
  const unused = async (): Promise<never> => {
    throw new Error("unused service operation");
  };
  const service: TandemService = {
    onboard: unused,
    models: unused,
    configureModels: unused,
    create: unused,
    list: unused,
    get: unused,
    approve: unused,
    tick: unused,
    pause: unused,
    resume: unused,
    cancel: unused,
    steer: unused,
    answer: unused,
    messages: unused,
    acknowledge: unused,
    describePr: unused,
    publish: unused,
    merge: unused,
    cleanup: async (_taskId, input = {}) => {
      cleanupInputs.push(input);
      return task;
    },
    present: unused,
    presentations: unused,
    feedback: unused,
    shutdown: async () => undefined,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: CliDependencies = {
    processEnvironment: { TANDEM_HOME: "/tmp/tandem", TANDEM_REPO: "/repo" },
    service,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };

  const safe = await runCli(["cleanup", "task-1", "--json"], dependencies);
  const destructive = await runCli(["cleanup", "task-1", "--discard", "--json"], dependencies);

  expect(safe.exitCode).toBe(0);
  expect(cleanupInputs).toEqual([{}]);
  expect(destructive.exitCode).toBe(2);
  expect(destructive.error?.name).toBe("CliConsentError");
  expect(stderr.join("")).toContain("discarding task-1 requires explicit --yes");
  expect(stdout.join("")).toContain('"stage":"cancelled"');
});

test("watch interruption stops its loop, closes owned polling, and removes signal handlers", async () => {
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  let removedHandlers = 0;
  const processSignals = {
    on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
      listeners.set(signal, listener);
    },
    removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
      removedHandlers += 1;
    },
  };
  const sleepStarted = Promise.withResolvers<void>();
  let releaseSleep!: () => void;
  let tickCalls = 0;
  let shutdownCalls = 0;
  const service = {
    tick: async () => {
      tickCalls += 1;
      return [];
    },
    shutdown: async () => {
      shutdownCalls += 1;
    },
  } as unknown as TandemService;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const resultPromise = runCli(["watch", "--json"], {
    processEnvironment: { TANDEM_HOME: "/tmp/tandem", TANDEM_REPO: "/repo" },
    createService: () => service,
    processSignals,
    sleep: async () => {
      sleepStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    },
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  await sleepStarted.promise;
  const interrupt = listeners.get("SIGINT");
  if (interrupt === undefined) throw new Error("SIGINT handler was not registered");
  interrupt();
  releaseSleep();

  const result = await resultPromise;
  expect(result.exitCode).not.toBe(0);
  expect(result.error?.name).toBe("CliInterruptError");
  expect(result.error?.message).toContain("SIGINT");
  expect(tickCalls).toBe(1);
  expect(shutdownCalls).toBe(1);
  expect(listeners.size).toBe(0);
  expect(removedHandlers).toBe(2);
  expect(stdout).toHaveLength(0);
  expect(stderr.join("")).toContain("SIGINT");
});

// This child-process test intentionally uses the platform timer; fake timers cannot prove
// that the real default sleep releases its referenced timeout after SIGINT.
test("default watch timer is cancelled when the real CLI child receives SIGINT", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-watch-signal-"));
  let child: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
  let exited = false;
  let timeout: Timer | undefined;
  try {
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const servicePath = join(import.meta.dir, "..", "src", "service.ts");
    const readyPath = join(root, "watch-ready");
    const probePath = join(root, "watch-probe.ts");
    const script = `
import { runCli } from ${JSON.stringify(cliPath)};
import type { TandemService } from ${JSON.stringify(servicePath)};

const service = {
  tick: async () => {
    await Bun.write(${JSON.stringify(readyPath)}, "ready");
    return [];
  },
  shutdown: async () => undefined,
} as unknown as TandemService;

const result = await runCli(["watch", "--interval-ms", "60000", "--json"], {
  processEnvironment: { TANDEM_HOME: "/tmp/tandem", TANDEM_REPO: "/repo" },
  service,
});
process.exitCode = result.exitCode;
`;
    await writeFile(probePath, script, "utf8");
    const spawned = Bun.spawn({
      cmd: [process.execPath, probePath],
      cwd: root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child = spawned;

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(readyPath, "utf8");
        ready = true;
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(ready).toBe(true);

    const startedAt = Date.now();
    spawned.kill("SIGINT");
    const exitCode = await Promise.race([
      spawned.exited,
      new Promise<number>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("watch child did not stop after SIGINT")),
          1_500,
        );
      }),
    ]);
    exited = true;
    expect(exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  } finally {
    clearTimeout(timeout);
    if (!exited) child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
