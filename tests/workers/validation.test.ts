import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, ValidationCommand } from "../../src/contracts.ts";
import type { ValidationResult } from "../../src/validation-worker.ts";
import { runValidation, ValidationConfigurationError } from "../../src/workers/validation.ts";

const command = (
  name: string,
  surfaces: readonly string[],
  argv: readonly string[] = ["bun", "run", name],
): ValidationCommand => ({
  name,
  argv,
  surfaces,
  timeoutMs: 1000,
});

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

test("runValidation selects matching, wildcard, and globally-scoped commands in declaration order", async () => {
  const commands = [
    command("global", []),
    command("lint", ["lint"]),
    command("test", ["test"]),
    command("wildcard", ["*"]),
  ];
  const calls: string[][] = [];
  const evidence = await runValidation({
    repoPath: "/virtual/repo",
    head: "abc123",
    surfaces: ["test"],
    commands,
    run: async (request) => {
      calls.push([...request.argv]);
      return result(0, request.argv.join(" "));
    },
  });

  expect(calls).toEqual([
    ["bun", "run", "global"],
    ["bun", "run", "test"],
    ["bun", "run", "wildcard"],
  ]);
  expect(evidence.map((entry) => entry.name)).toEqual(["global", "test", "wildcard"]);
  expect(evidence.every((entry) => entry.head === "abc123")).toBe(true);
});

test("runValidation records a failed check and stops before later commands", async () => {
  const calls: string[] = [];
  const evidence = await runValidation({
    repoPath: "/virtual/repo",
    head: "failed-head",
    surfaces: ["test"],
    commands: [command("test", ["test"]), command("later", ["test"])],
    run: async (request) => {
      calls.push(request.argv[2] ?? "");
      return result(2, "partial output", "assertion failed");
    },
  });

  expect(calls).toEqual(["test"]);
  expect(evidence).toEqual([
    {
      name: "test",
      argv: ["bun", "run", "test"],
      exitCode: 2,
      stdout: "partial output",
      stderr: "assertion failed",
      head: "failed-head",
    },
  ]);
});

test("runValidation records cancellation evidence without invoking an aborted command", async () => {
  const controller = new AbortController();
  controller.abort("user stopped validation");
  let invoked = false;

  const evidence = await runValidation({
    repoPath: "/virtual/repo",
    head: "cancelled-head",
    surfaces: ["test"],
    commands: [command("test", ["test"])],
    signal: controller.signal,
    run: async () => {
      invoked = true;
      return result(0);
    },
  });

  expect(invoked).toBe(false);
  expect(evidence[0]).toMatchObject({
    name: "test",
    exitCode: 130,
    head: "cancelled-head",
    stderr: "user stopped validation",
  });
});

test("runValidation records a timeout after the runner observes abort", async () => {
  let observedAbort = false;
  const evidence = await runValidation({
    repoPath: "/virtual/repo",
    head: "timed-out-head",
    surfaces: ["test"],
    commands: [{ ...command("test", ["test"]), timeoutMs: 1 }],
    run: async ({ signal }) => {
      if (signal === undefined) throw new Error("runner did not receive a signal");
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return result(0);
    },
  });

  expect(observedAbort).toBe(true);
  expect(evidence[0]).toMatchObject({
    name: "test",
    exitCode: 124,
    head: "timed-out-head",
  });
});

test("runValidation waits for runner cleanup before returning timeout evidence", async () => {
  const abortObserved = Promise.withResolvers<void>();
  const cleanupReleased = Promise.withResolvers<void>();
  let commandSettled = false;
  const validation = runValidation({
    repoPath: "/virtual/repo",
    head: "timed-out-head",
    surfaces: ["test"],
    commands: [{ ...command("test", ["test"]), timeoutMs: 1 }],
    run: async ({ signal }) => {
      if (signal === undefined) throw new Error("runner did not receive a signal");
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            abortObserved.resolve();
            resolve();
          },
          { once: true },
        );
      });
      await cleanupReleased.promise;
      commandSettled = true;
      return result(0);
    },
  });
  let validationSettled = false;
  const evidencePromise = validation.then((evidence) => {
    validationSettled = true;
    return evidence;
  });
  await abortObserved.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(validationSettled).toBe(false);
  expect(commandSettled).toBe(false);

  cleanupReleased.resolve();
  const evidence = await evidencePromise;
  expect(commandSettled).toBe(true);
  expect(evidence[0]).toMatchObject({
    name: "test",
    exitCode: 124,
    head: "timed-out-head",
  });
});

test("runValidation rejects when no configured command applies", async () => {
  await expect(
    runValidation({
      repoPath: "/virtual/repo",
      head: "head",
      surfaces: ["docs"],
      commands: [],
      run: async () => result(0),
    }),
  ).rejects.toBeInstanceOf(ValidationConfigurationError);
});

test("persists cancellation when SIGINT arrives while loading a validation job", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-validation-worker-signal-"));
  const jobPath = join(root, "job.fifo");
  const resultPath = join(root, "result.json");
  const markerPath = join(root, "command-ran");
  const workerPath = join(import.meta.dir, "..", "..", "src", "validation-worker.ts");
  let worker: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let workerExited = false;

  try {
    const fifo = Bun.spawn({
      cmd: ["mkfifo", jobPath],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await fifo.exited).toBe(0);

    const job = {
      schemaVersion: 1,
      id: "validation-worker-signal",
      taskId: "task-1",
      generation: 1,
      repoPath: root,
      head: "abc123",
      surfaces: ["test"],
      commands: [
        {
          name: "probe",
          argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(markerPath)}, "ran")`],
          surfaces: ["test"],
          timeoutMs: 1000,
        },
      ],
      resultPath,
    };

    worker = Bun.spawn({
      cmd: [process.execPath, workerPath, jobPath],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const writer = await open(jobPath, "w");

    let writeError: unknown;
    try {
      worker.kill("SIGINT");
      try {
        await writer.write(`${JSON.stringify(job)}\n`);
      } catch (error) {
        writeError = error;
      }
    } finally {
      await writer.close();
    }
    expect(writeError).toBeUndefined();

    const exitCode = await worker.exited;
    workerExited = true;

    const [stdout, stderr] = await Promise.all([
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
    ]);
    const persisted = JSON.parse(await readFile(resultPath, "utf8")) as ValidationResult;

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout) as ValidationResult).toEqual(persisted);
    expect(persisted).toMatchObject({
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      head: job.head,
      status: "failed",
    });
    expect(persisted.evidence).toEqual([
      expect.objectContaining({
        name: "probe",
        exitCode: 130,
        head: job.head,
      }),
    ]);
    expect(await Bun.file(markerPath).exists()).toBe(false);
  } finally {
    if (!workerExited) worker?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
