import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShellArgument, runCommand } from "../../src/adapters/commands.ts";
import { runCli } from "../../src/cli.ts";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { CommandRequest, CommandRunner, TaskRecord } from "../../src/contracts.ts";
import {
  buildCoordinatorArgv,
  type CoordinatorLaunchRequest,
  launchCoordinator,
} from "../../src/coordinator/launch.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  type CliApplication,
  type CliDependencies,
  createCliApplication,
} from "../../src/terminal/cli-application.ts";
import { parseCliArgs } from "../../src/terminal/cli-arguments.ts";

async function writeOmpProbe(root: string, exitCode = 0): Promise<string> {
  const outputPath = join(root, "omp-probe-output.txt");
  const script = `#!/bin/sh
{
  printf 'PWD=%s\n' "$(pwd)"
  printf 'AUTH_TOKEN=%s\n' "$AUTH_TOKEN"
  printf 'HERDR_ENV=%s\n' "$HERDR_ENV"
  printf 'HERDR_SESSION=%s\n' "$HERDR_SESSION"
  printf 'HERDR_WORKSPACE_ID=%s\n' "$HERDR_WORKSPACE_ID"
  printf 'HERDR_PANE_ID=%s\n' "$HERDR_PANE_ID"
  printf 'TANDEM_HOME=%s\n' "$TANDEM_HOME"
  printf 'TANDEM_POOL_ROOT=%s\n' "$TANDEM_POOL_ROOT"
  printf 'TANDEM_SESSION=%s\n' "$TANDEM_SESSION"
  printf 'TANDEM_REPO=%s\n' "$TANDEM_REPO"
  printf 'TANDEM_SOURCE_REPO=%s\n' "$TANDEM_SOURCE_REPO"
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

type CoordinatorRunnerInput = Readonly<{
  readonly repo: string;
  readonly poolRoot: string;
  readonly cleanRepo: string;
  readonly model: Readonly<{ readonly model: string; readonly thinking: string }>;
  readonly sourceHead?: string;
  readonly originalDirty?: boolean;
  readonly cleanDirty?: boolean;
  readonly cleanHead?: string;
  readonly startServer?: boolean;
  readonly existingLease?: Readonly<{ readonly leaseHolder: string; readonly branch: string }>;
  readonly recordedCommand?: readonly string[];
  readonly startupTransitionCount?: number;
  readonly herdrEnvironment?: Readonly<Record<string, string>>;
}>;

function coordinatorRunner(input: CoordinatorRunnerInput): Readonly<{
  readonly calls: readonly CommandRequest[];
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  const sourceHead = input.sourceHead ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let cleanHead = input.cleanHead ?? sourceHead;
  let branch = input.existingLease?.branch ?? "";
  let processInfoCalls = 0;
  let herdrStatusCalls = 0;
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const [program] = request.argv;
    // No coordinator runs outside its pane in these scenarios.
    if (program === "ps") return { code: 0, stdout: "", stderr: "" };
    if (program === "omp" && request.argv[1] === "models") {
      return {
        code: 0,
        stdout: JSON.stringify({
          models: [
            {
              selector: input.model.model,
              id: "model-id",
              provider: "openai",
              thinking: [input.model.thinking],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (program === "herdr") {
      if (request.argv.includes("api") && request.argv.includes("snapshot")) {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { type: "session_snapshot", snapshot: { panes: [] } } }),
          stderr: "",
        };
      }
      if (request.argv.includes("pane") && request.argv.includes("get")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "pane-2",
                tab_id: "tab-2",
                workspace_id: "workspace-2",
                foreground_cwd: input.cleanRepo,
              },
            },
          }),
          stderr: "",
        };
      }
      if (request.argv.includes("pane") && request.argv.includes("process-info")) {
        processInfoCalls += 1;
        const inStartupTransition =
          input.startupTransitionCount !== undefined &&
          processInfoCalls <= input.startupTransitionCount;
        const processName = inStartupTransition ? "env" : "omp";
        const processCommand = inStartupTransition ? ["env"] : (input.recordedCommand ?? ["omp"]);
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "pane-2",
                foreground_processes: [{ pid: 123, name: processName, argv: processCommand }],
              },
            },
          }),
          stderr: "",
        };
      }
      if (request.argv.includes("status")) {
        const running = input.startServer !== true || herdrStatusCalls > 0;
        herdrStatusCalls += 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            server: {
              socket: "/tmp/herdr.sock",
              running,
              session: request.argv[2],
            },
          }),
          stderr: "",
        };
      }
      if (request.argv.includes("workspace") && request.argv.includes("create")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: "workspace-2" },
              tab: { tab_id: "tab-2" },
              root_pane: { pane_id: "pane-2" },
            },
          }),
          stderr: "",
        };
      }
      if (request.argv.includes("pane") && request.argv.includes("run")) {
        const shellCommand = request.argv.at(-1);
        if (shellCommand === undefined)
          throw new Error("pane run command omitted generated shell command");
        return runCommand({
          argv: ["/bin/sh", "-c", shellCommand],
          cwd: request.cwd,
          env: { ...(request.env ?? {}), ...(input.herdrEnvironment ?? {}) },
        });
      }
    }
    if (program === "treehouse") {
      if (request.argv.includes("status")) {
        const record = input.existingLease;
        return {
          code: 0,
          stdout:
            record === undefined
              ? "[]"
              : JSON.stringify([
                  {
                    path: input.cleanRepo,
                    lease_id: "lease-coordinator",
                    lease_holder: record.leaseHolder,
                    leased_at: "2030-01-02T03:04:05.000Z",
                  },
                ]),
          stderr: "",
        };
      }
      if (request.argv.includes("get")) {
        const holderIndex = request.argv.indexOf("--lease-holder");
        const holder = request.argv[holderIndex + 1] ?? "coordinator-fixture";
        return {
          code: 0,
          stdout: JSON.stringify({
            path: input.cleanRepo,
            lease_id: "lease-coordinator",
            lease_holder: holder,
            leased_at: "2030-01-02T03:04:05.000Z",
          }),
          stderr: "",
        };
      }
    }
    if (program === "git") {
      if (request.argv.includes("remote")) {
        return { code: 0, stdout: "\n", stderr: "" };
      }
      const pathIndex = request.argv.indexOf("-C");
      const gitPath = pathIndex === -1 ? request.cwd : request.argv[pathIndex + 1];
      if (request.argv.includes("--git-common-dir")) {
        await mkdir(join(input.repo, ".git"), { recursive: true });
        return { code: 0, stdout: `${input.repo}/.git\n`, stderr: "" };
      }
      if (request.argv.includes("--show-toplevel")) {
        return { code: 0, stdout: `${gitPath}\n`, stderr: "" };
      }
      if (request.argv.includes("symbolic-ref")) return { code: 0, stdout: "main\n", stderr: "" };
      if (request.argv.includes("switch")) {
        const switchIndex = request.argv.indexOf("switch");
        const branchIndex = request.argv.findIndex(
          (arg, index) => index > switchIndex && (arg === "-c" || arg === "-C"),
        );
        branch = request.argv[branchIndex + 1] ?? "";
        cleanHead = request.argv.at(-1) ?? sourceHead;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (request.argv.includes("branch") && request.argv.includes("--show-current")) {
        return { code: 0, stdout: `${branch}\n`, stderr: "" };
      }
      if (request.argv.includes("cat-file")) {
        return { code: 0, stdout: `${sourceHead}\n`, stderr: "" };
      }
      if (request.argv.includes("rev-parse") && request.argv.includes("--verify")) {
        return { code: 0, stdout: `${sourceHead}\n`, stderr: "" };
      }
      if (request.argv.includes("rev-parse") && request.argv.includes("HEAD")) {
        return {
          code: 0,
          stdout: `${gitPath === input.repo ? sourceHead : cleanHead}\n`,
          stderr: "",
        };
      }
      if (request.argv.includes("diff")) return { code: 0, stdout: "", stderr: "" };
      if (request.argv.includes("status")) {
        const dirty =
          gitPath === input.repo ? input.originalDirty !== false : input.cleanDirty === true;
        return { code: 0, stdout: dirty ? " M user-source.txt\n" : "", stderr: "" };
      }
      if (request.argv.includes("diff-filter=U")) return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${request.argv.join(" ")}`);
  };
  return { calls, run };
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
    "Reviewed change",
    "main",
    '{"tldr":["safe"],"what":["changed"],"why":["needed"]}',
    "--yes",
    "--json",
  ]);

  expect(invocation.command).toBe("publish");
  expect(invocation.positionals).toEqual([
    "task-1",
    "Reviewed change",
    "main",
    '{"tldr":["safe"],"what":["changed"],"why":["needed"]}',
  ]);
  expect(invocation.options.yes).toBe(true);
  expect(invocation.options.json).toBe(true);

  const draft = parseCliArgs(["pr", "draft", "task-1", "Draft title", "main", "--yes"]);
  expect(draft.command).toBe("draft");
  expect(draft.positionals).toEqual(["task-1", "Draft title", "main"]);
  expect(draft.options.yes).toBe(true);
  expect(parseCliArgs(["pr", "draft", "task-1", "Draft title", "main"]).options.yes).toBe(false);
});
test("inspection and delivery CLI commands keep their inputs", () => {
  const inspection = parseCliArgs(["inspect", "task-1", "--json"]);
  expect(inspection.command).toBe("inspect");
  expect(inspection.options.yes).toBe(false);

  const preflight = parseCliArgs(["delivery-preflight", "task-1", "main"]);
  expect(preflight.command).toBe("delivery-preflight");
  expect(preflight.positionals).toEqual(["task-1", "main"]);
});

test("restart CLI preserves the explicit managed-worker command contract", () => {
  const invocation = parseCliArgs([
    "restart",
    "task-1",
    "--repo",
    "/repo",
    "--home",
    "/home",
    "--json",
  ]);
  expect(invocation.command).toBe("restart");
  expect(invocation.positionals).toEqual(["task-1"]);
  expect(invocation.options.repo).toBe("/repo");
  expect(invocation.options.json).toBe(true);
});
test("cancel CLI exposes the durable stop command with explicit consent", () => {
  const invocation = parseCliArgs([
    "cancel",
    "--task",
    "task-1",
    "--reason",
    "stop the runaway worker",
    "--yes",
  ]);
  expect(invocation.command).toBe("cancel");
  expect(invocation.options.taskId).toBe("task-1");
  expect(invocation.options.reason).toBe("stop the runaway worker");
  expect(invocation.options.yes).toBe(true);
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
  expect(argv).toContain("read,ask,tandem");
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
    const settings = Bun.TOML.parse(await readFile(setup.configPath, "utf8"));

    expect(result.approved).toBe(true);
    expect(setup.repoPath).toBe(await realpath(requestedRepo));
    expect(setup.configPath).toContain(join("tandem-home ", "repositories"));
    expect(settings).toEqual({ repoPath: setup.repoPath });
    await expect(readFile(join(requestedRepo, ".tandem.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(ordinaryRepo, ".tandem.json"), "utf8")).rejects.toThrow();
  } finally {
    await application?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI launches a clean coordinator while preserving dirty original source identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-launch-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    const userSource = join(repo, "user-source.txt");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    const expectedCleanRepo = await realpath(cleanRepo);
    await writeFile(userSource, "keep this edit\n", "utf8");
    const outputPath = await writeOmpProbe(root);
    const model = defaultPolicy().models.coordinator;
    const runner = coordinatorRunner({ repo, poolRoot, cleanRepo, model });
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
      run: runner.run,
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
        TANDEM_SOURCE_REPO: undefined,
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
      repoPath: repo,
      worktree: { path: cleanRepo, baseHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      workspaceId: "workspace-1",
      paneId: "pane-1",
    });
    const observed = await readFile(outputPath, "utf8");
    expect(observed).toContain(`PWD=${expectedCleanRepo}\n`);
    expect(observed).toContain("AUTH_TOKEN=preserve-me\n");
    expect(observed).toContain("HERDR_ENV=1\n");
    expect(observed).toContain("HERDR_SESSION=tandem-session\n");
    expect(observed).toContain("HERDR_WORKSPACE_ID=workspace-1\n");
    expect(observed).toContain("HERDR_PANE_ID=pane-1\n");
    expect(observed).toContain(`TANDEM_HOME=${home}\n`);
    expect(observed).toContain(`TANDEM_POOL_ROOT=${poolRoot}\n`);
    expect(observed).toContain("TANDEM_SESSION=tandem-session\n");
    expect(observed).toContain(`TANDEM_REPO=${repo}\n`);
    expect(observed).toContain(`TANDEM_SOURCE_REPO=${cleanRepo}\n`);
    expect(observed).toContain("TANDEM_PARENT_WORKSPACE=explicit-parent\n");
    const sessionArgument = observed
      .split("\n")
      .find((line) => line.startsWith("ARG_") && line.includes("/coordinator-sessions/"));
    expect(sessionArgument).toContain(`${home}/coordinator-sessions/`);
    expect(sessionArgument).toMatch(/[a-f0-9]{24}$/u);
    expect(await readFile(userSource, "utf8")).toBe("keep this edit\n");
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
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    const expectedCleanRepo = await realpath(cleanRepo);
    const outputPath = await writeOmpProbe(root, 7);
    const model = defaultPolicy().models.coordinator;
    const runner = coordinatorRunner({
      repo,
      poolRoot,
      cleanRepo,
      model,
    });
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
        TANDEM_SOURCE_REPO: undefined,
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
            run: runner.run,
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
    expect(await readFile(outputPath, "utf8")).toContain(`PWD=${expectedCleanRepo}\n`);
    expect(await readFile(outputPath, "utf8")).toContain(`TANDEM_SOURCE_REPO=${cleanRepo}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchCoordinator cold-starts and relaunches a saved coordinator after its server stops", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-cli-pane-")));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator home");
    const poolRoot = join(root, "coordinator pool");
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    const expectedCleanRepo = await realpath(cleanRepo);
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
    const sessionKey = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    const recordedCommand = buildCoordinatorArgv({
      cwd: cleanRepo,
      model: request.model,
      configPath: request.configPath,
      extensionPath: request.extensionPath,
      continueSession: request.continueSession,
      sessionDirectory: join(home, "coordinator-sessions", sessionKey),
    });
    const path = `${root}:/usr/bin:/bin`;
    const herdrEnvironment = {
      HERDR_ENV: "1",
      HERDR_SESSION: "herdr-session",
      HERDR_WORKSPACE_ID: "herdr-workspace",
      HERDR_PANE_ID: "herdr-pane",
    } as const;
    const runnerInput = {
      repo,
      recordedCommand,
      poolRoot,
      cleanRepo,
      model: request.model,
      startServer: true,
      startupTransitionCount: 1,
      herdrEnvironment,
    };
    let runner = coordinatorRunner(runnerInput);
    let startPersistentCalls = 0;
    let serverRunning = false;
    let restoredLabel = "Tandem coordinator · repo";
    // The previous coordinator's pane/process state before its owned pane closes, distinct
    // from the freshly created replacement pane the underlying coordinatorRunner simulates.
    let oldPaneClosed = false;
    let newWorkspaceCreated = false;
    const run: CommandRunner = async (call) => {
      if (call.argv[0] === "herdr" && !serverRunning) {
        if (call.argv.includes("status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              server: { socket: "/tmp/herdr.sock", running: false, session: request.sessionId },
            }),
            stderr: "",
          };
        }
        return {
          code: 1,
          stdout: JSON.stringify({ error: { code: "server_not_running" } }),
          stderr: "",
        };
      }
      if (
        call.argv[0] === "herdr" &&
        call.argv[3] === "workspace" &&
        (call.argv[4] === "get" || call.argv[4] === "rename")
      ) {
        if (call.argv[4] === "rename") restoredLabel = call.argv[6] ?? restoredLabel;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              type: "workspace_info",
              workspace: { workspace_id: "workspace-2", label: restoredLabel },
            },
          }),
          stderr: "",
        };
      }
      if (!newWorkspaceCreated && call.argv[0] === "herdr" && call.argv[3] === "pane") {
        if (call.argv[4] === "get") {
          if (oldPaneClosed) {
            return {
              code: 1,
              stdout: "",
              stderr: JSON.stringify({ error: { code: "pane_not_found" } }),
            };
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                pane: {
                  pane_id: "pane-2",
                  tab_id: "tab-2",
                  workspace_id: "workspace-2",
                  foreground_cwd: cleanRepo,
                },
              },
            }),
            stderr: "",
          };
        }
        if (call.argv[4] === "process-info") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                process_info: {
                  pane_id: "pane-2",
                  shell_pid: 999,
                  foreground_processes: [{ pid: 999, name: "zsh", argv: ["-zsh"], argv0: "-zsh" }],
                },
              },
            }),
            stderr: "",
          };
        }
        if (call.argv[4] === "close") {
          oldPaneClosed = true;
          return { code: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" };
        }
      }
      if (call.argv[0] === "herdr" && call.argv[3] === "workspace" && call.argv[4] === "create") {
        newWorkspaceCreated = true;
      }
      return runner.run(call);
    };
    const result = await withProcessEnvironment(
      {
        AUTH_TOKEN: "preserve-me",
        PATH: path,
      },
      async () => {
        const dependencies = {
          run,
          startPersistent: async () => {
            startPersistentCalls += 1;
            serverRunning = true;
            return undefined;
          },
          runInteractive: async () => {
            throw new Error("new-pane launch must not start OMP in the parent process");
          },
          sleep: async () => undefined,
          processEnvironment: { AUTH_TOKEN: "preserve-me" },
        };
        const first = await launchCoordinator(request, dependencies);
        const leaseHolder = `coordinator:${[repo, request.sessionId, first.worktree.baseHead]
          .map((value) => createHash("sha256").update(value).digest("hex").slice(0, 16))
          .join(":")}`;
        runner = coordinatorRunner({
          ...runnerInput,
          startServer: false,
          existingLease: { leaseHolder, branch: first.worktree.branch },
        });
        serverRunning = false;
        newWorkspaceCreated = false;
        return launchCoordinator(request, dependencies);
      },
    );
    expect(startPersistentCalls).toBe(2);
    expect(result.reused).toBeUndefined();
    // The default behavior closes the previous coordinator's owned pane instead of retaining it.
    expect(oldPaneClosed).toBe(true);
    expect(restoredLabel).toBe("Tandem coordinator · repo");

    expect(result.direct).toBe(false);
    expect(result.repoPath).toBe(repo);
    expect(result.worktree.path).toBe(cleanRepo);
    expect(result.workspaceId).toBe("workspace-2");
    expect(result.tabId).toBe("tab-2");
    expect(result.paneId).toBe("pane-2");
    const observed = await readFile(outputPath, "utf8");
    expect(observed).toContain(`PWD=${expectedCleanRepo}\n`);
    expect(observed).toContain("HERDR_SESSION=herdr-session\n");
    expect(observed).toContain("AUTH_TOKEN=preserve-me\n");
    expect(observed).toContain("HERDR_ENV=1\n");
    expect(observed).toContain("HERDR_WORKSPACE_ID=herdr-workspace\n");
    expect(observed).toContain("HERDR_PANE_ID=herdr-pane\n");
    expect(observed).toContain(`TANDEM_HOME=${home}\n`);
    expect(observed).toContain(`TANDEM_POOL_ROOT=${poolRoot}\n`);
    expect(observed).toContain("TANDEM_SESSION=pane-session\n");
    expect(observed).toContain(`TANDEM_REPO=${repo}\n`);
    expect(observed).toContain(`TANDEM_SOURCE_REPO=${cleanRepo}\n`);
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
test("launchCoordinator reconnects to the pinned coordinator after the original HEAD advances", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-cli-reconnect-")));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    await writeOmpProbe(root);
    const fixturePath = `${root}:/usr/bin:/bin`;
    const model = defaultPolicy().models.coordinator;
    const request: CoordinatorLaunchRequest = {
      cwd: repo,
      repo,
      sourceRepo: cleanRepo,
      home,
      poolRoot,
      sessionId: "reconnect-session",
      model,
      configPath: "/tandem/src/worker-config.yml",
      extensionPath: "/tandem/src/extension.ts",
      continueSession: true,
      headless: true,
      noAttach: false,
    };
    const sessionKey = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    const recordedCommand = buildCoordinatorArgv({
      cwd: cleanRepo,
      model,
      configPath: "/tandem/src/worker-config.yml",
      extensionPath: "/tandem/src/extension.ts",
      continueSession: true,
      sessionDirectory: join(home, "coordinator-sessions", sessionKey),
    });
    const firstRunner = coordinatorRunner({
      repo,
      poolRoot,
      cleanRepo,
      model,
      sourceHead: "1111111111111111111111111111111111111111",
      cleanHead: "1111111111111111111111111111111111111111",
      recordedCommand,
      herdrEnvironment: { PATH: fixturePath },
      startServer: true,
    });
    const first = await launchCoordinator(request, {
      run: firstRunner.run,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("first launch should use a Herdr workspace");
      },
      sleep: async () => undefined,
      processEnvironment: {},
    });
    expect(first.direct).toBe(false);
    expect(first.worktree.baseHead).toBe("1111111111111111111111111111111111111111");

    const secondRunner = coordinatorRunner({
      repo,
      poolRoot,
      cleanRepo,
      model,
      sourceHead: "2222222222222222222222222222222222222222",
      cleanHead: "1111111111111111111111111111111111111111",
      recordedCommand,
      herdrEnvironment: { PATH: fixturePath },
    });
    const second = await launchCoordinator(request, {
      run: secondRunner.run,
      startPersistent: async () => {
        throw new Error("reconnect must not start another Herdr server");
      },
      runInteractive: async () => {
        throw new Error("reconnect must not launch a second coordinator");
      },
      sleep: async () => undefined,
      processEnvironment: {},
    });
    expect(second.reused).toBe(true);
    expect(second.repoPath).toBe(repo);
    expect(second.worktree.path).toBe(cleanRepo);
    expect(second.worktree.baseHead).toBe("1111111111111111111111111111111111111111");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchCoordinator retires the old generated workspace label before replacing it and retries after a rename failure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-cli-retire-")));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    await writeOmpProbe(root);
    const model = defaultPolicy().models.coordinator;
    const request: CoordinatorLaunchRequest = {
      cwd: repo,
      repo,
      sourceRepo: cleanRepo,
      home,
      poolRoot,
      sessionId: "retire-session",
      model,
      configPath: "/tandem/src/worker-config.yml",
      extensionPath: "/tandem/src/extension.ts",
      continueSession: true,
      headless: true,
      noAttach: false,
    };
    const sessionKey = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    const recordedCommand = buildCoordinatorArgv({
      cwd: cleanRepo,
      model,
      configPath: request.configPath,
      extensionPath: request.extensionPath,
      continueSession: true,
      sessionDirectory: join(home, "coordinator-sessions", sessionKey),
    });
    const inner = () =>
      coordinatorRunner({
        repo,
        poolRoot,
        cleanRepo,
        model,
        recordedCommand,
        herdrEnvironment: { PATH: `${root}:/usr/bin:/bin` },
      });
    const first = await launchCoordinator(request, {
      run: inner().run,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("launch should use a Herdr workspace");
      },
      sleep: async () => undefined,
      processEnvironment: {},
    });
    const recordFile = recordPath(home, "retire-session", repo);
    const stale = await readCoordinatorRecord(recordFile);
    if (stale === undefined) throw new Error("first launch did not record a coordinator");
    const oldRecord = {
      ...stale,
      endpoint: { ...stale.endpoint, workspaceId: "old-workspace", paneId: "old-pane" },
      worktree: { ...stale.worktree, path: join(stale.worktree.root, "gone") },
    };
    await saveCoordinatorRecord(home, oldRecord);
    expect(first.workspaceId).toBe("workspace-2");

    let renameFails = true;
    let renames = 0;
    let creates = 0;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const holderKey = `${hash(repo)}-${hash("retire-session")}-${hash("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}`;
    const base = coordinatorRunner({
      repo,
      poolRoot,
      cleanRepo,
      model,
      recordedCommand,
      herdrEnvironment: { PATH: `${root}:/usr/bin:/bin` },
      existingLease: {
        leaseHolder: `coordinator:${holderKey.replaceAll("-", ":")}`,
        branch: `tandem/coordinator-${holderKey}`,
      },
    }).run;
    const run: CommandRunner = async (call) => {
      const argv = call.argv;
      if (argv[0] === "herdr" && argv.includes("workspace")) {
        if (argv.includes("get") && argv.at(-1) === "old-workspace") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                type: "workspace_info",
                workspace: {
                  workspace_id: "old-workspace",
                  label: `Tandem coordinator · repo`,
                },
              },
            }),
            stderr: "",
          };
        }
        if (argv.includes("rename")) {
          renames += 1;
          if (argv[argv.indexOf("rename") + 1] !== "old-workspace") {
            throw new Error("renamed a workspace other than the previous coordinator");
          }
          if (renameFails) return { code: 1, stdout: "", stderr: "rename failed" };
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                type: "workspace_info",
                workspace: { workspace_id: "old-workspace", label: argv.at(-1) },
              },
            }),
            stderr: "",
          };
        }
        if (argv.includes("create")) creates += 1;
      }
      // The previous coordinator's workspace still has another pane in it, which is why
      // retiring it renames the workspace instead of closing it outright.
      if (argv[0] === "herdr" && argv.includes("api") && argv.includes("snapshot")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              type: "session_snapshot",
              snapshot: {
                panes: [
                  {
                    workspace_id: "old-workspace",
                    tab_id: "old-sibling-tab",
                    pane_id: "old-sibling",
                  },
                ],
              },
            },
          }),
          stderr: "",
        };
      }
      if (
        argv[0] === "herdr" &&
        argv[3] === "pane" &&
        argv[4] === "get" &&
        argv.at(-1) === "old-pane"
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "pane_not_found" } }),
        };
      }
      if (argv[0] === "herdr" && argv[3] === "pane" && argv.at(-1)?.includes("old-sibling")) {
        if (argv[4] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                pane: {
                  pane_id: "old-sibling",
                  tab_id: "old-sibling-tab",
                  workspace_id: "old-workspace",
                  foreground_cwd: cleanRepo,
                },
              },
            }),
            stderr: "",
          };
        }
        if (argv[4] === "process-info") {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                process_info: {
                  pane_id: "old-sibling",
                  shell_pid: 111,
                  foreground_processes: [{ pid: 111, name: "zsh", argv: ["-zsh"], argv0: "-zsh" }],
                },
              },
            }),
            stderr: "",
          };
        }
      }
      return base(call);
    };
    const dependencies = {
      run,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("launch should use a Herdr workspace");
      },
      sleep: async () => undefined,
      processEnvironment: {},
    };

    await expect(launchCoordinator(request, dependencies)).rejects.toThrow();
    expect(creates).toBe(0);
    expect((await readCoordinatorRecord(recordFile))?.endpoint.workspaceId).toBe("old-workspace");

    renameFails = false;
    const retried = await launchCoordinator(request, dependencies);
    expect(retried.reused).toBeUndefined();
    expect(creates).toBe(1);
    expect(renames).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchCoordinator rejects an unsafe reused coordinator lease without cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-unsafe-reuse-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "coordinator-home");
    const poolRoot = join(root, "coordinator-pool");
    const cleanRepo = join(poolRoot, "coordinator-worktree");
    await mkdir(repo, { recursive: true });
    await mkdir(cleanRepo, { recursive: true });
    const sessionId = "unsafe-session";
    const sourceHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const repositoryKey = hash(repo);
    const sessionKey = hash(sessionId);
    const sourceKey = hash(sourceHead);
    const taskName = `coordinator-${repositoryKey}-${sessionKey}-${sourceKey}`;
    const runner = coordinatorRunner({
      repo,
      poolRoot,
      cleanRepo,
      model: defaultPolicy().models.coordinator,
      sourceHead,
      originalDirty: true,
      cleanDirty: true,
      existingLease: {
        leaseHolder: `coordinator:${repositoryKey}:${sessionKey}:${sourceKey}`,
        branch: `tandem/${taskName}`,
      },
    });

    await expect(
      launchCoordinator(
        {
          cwd: repo,
          repo,
          home,
          poolRoot,
          sessionId,
          model: defaultPolicy().models.coordinator,
          configPath: "/tandem/src/worker-config.yml",
          extensionPath: "/tandem/src/extension.ts",
          continueSession: false,
          headless: true,
          noAttach: false,
        },
        {
          run: runner.run,
          startPersistent: async () => undefined,
          runInteractive: async () => {
            throw new Error("unsafe reuse must fail before launching");
          },
          sleep: async () => undefined,
          processEnvironment: {},
        },
      ),
    ).rejects.toThrow(/worktree is dirty/u);

    expect(
      runner.calls.some((call) => call.argv.includes("return") || call.argv.includes("destroy")),
    ).toBe(false);
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
    inspect: unused,
    trace: unused,
    traceSummary: unused,
    deliveryPreflight: unused,
    approve: unused,
    draftRequestBrief: unused,
    reviewRequestBrief: unused,
    approveRequestBrief: unused,
    abandonRequestBrief: unused,
    pendingBriefApprovalId: unused,
    requestBrief: unused,
    requestReceipt: unused,
    tick: unused,
    pause: unused,
    resume: unused,
    restart: unused,
    cancel: unused,
    steer: unused,
    answer: unused,
    messages: unused,
    acknowledge: unused,
    describePr: unused,
    publish: unused,
    publishNow: unused,
    publishDraft: unused,
    merge: unused,
    cleanup: async (_taskId, input = {}) => {
      cleanupInputs.push(input);
      return task;
    },
    present: unused,
    presentations: unused,
    feedback: unused,
    openPresentation: unused,
    requestBriefs: unused,
    reviewPr: unused,
    reviewShow: unused,
    reviewNotes: unused,
    reviewEdit: unused,
    reviewPost: unused,
    reviewAgain: unused,
    reviewClose: unused,
    board: unused,
    notifyNeedsYou: unused,
    prWatch: unused,
    prWatchStart: unused,
    prWatchStop: unused,
    prWatchNotices: unused,
    prWatchFix: unused,
    mergingCheck: unused,
    saveMerging: unused,
    workerSkillOffer: unused,
    saveWorkerSkills: unused,
    selfImprovementMode: unused,
    investigationQuestions: unused,
    investigate: unused,
    reviewIssue: unused,
    fileIssue: unused,
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
    const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const servicePath = join(import.meta.dir, "..", "..", "src", "service", "controller.ts");
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

test("onboard --json adds the merging check and worker skill offer; saving merging needs --yes", async () => {
  const saved: unknown[] = [];
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-merging-"));
  const input = join(root, "merging.json");
  await writeFile(
    input,
    JSON.stringify({ mergeWith: "queue-label", queueLabel: "ready-to-merge" }),
  );
  const service = {
    onboard: async () => ({ repoPath: "/repo", existingConfig: true }),
    mergingCheck: async () => ({ repo: "acme/app", readable: true, method: "aviator" }),
    workerSkillOffer: async () => ["buildkite"],
    saveMerging: async (value: unknown) => {
      saved.push(value);
      return { mergeWith: "queue-label" };
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  const stdout: string[] = [];
  const dependencies = {
    processEnvironment: { TANDEM_HOME: join(root, "home"), TANDEM_REPO: "/repo" },
    service,
    stdout: (value: string) => stdout.push(value),
    stderr: () => undefined,
  };
  try {
    expect((await runCli(["onboard", "--json"], dependencies)).exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      repoPath: "/repo",
      existingConfig: true,
      merging: { repo: "acme/app", readable: true, method: "aviator" },
      workerSkillOffer: ["buildkite"],
    });
    expect((await runCli(["configure-merging", "--input", input], dependencies)).exitCode).toBe(2);
    expect(saved).toEqual([]);
    const result = await runCli(["configure-merging", "--input", input, "--yes"], dependencies);
    expect(result.exitCode).toBe(0);
    expect(saved).toEqual([
      { repoPath: "/repo", choice: { mergeWith: "queue-label", queueLabel: "ready-to-merge" } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
