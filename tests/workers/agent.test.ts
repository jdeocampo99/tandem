import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, LaunchIo, LaunchSpec, StartedAgent } from "../../src/harness/contract.ts";
import { harnessFor } from "../../src/harness/resolve.ts";
import { formatTaskMessages } from "../../src/tasks/communication-protocol.ts";
import type { RunInteractive } from "../../src/terminal/cli-process.ts";
import { runWorkerAgent, type WorkerAgentDependencies } from "../../src/workers/agent.ts";
import { WORKER_CONTROL_ENV } from "../../src/workers/control-protocol.ts";
import { parseWorkerJob } from "../../src/workers/jobs.ts";
import { WORKER_JOB_PATH_ENV } from "../../src/workers/terminal.ts";

function fixture(root = "/tmp/tandem-worker-agent") {
  const job = parseWorkerJob({
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 3,
    role: "implementer",
    cwd: root,
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    prompt: "Complete the approved brief.",
    resultPath: join(root, "result.json"),
  });
  const events: string[] = [];
  const requests: Parameters<RunInteractive>[0][] = [];
  const specs: LaunchSpec[] = [];
  const started: StartedAgent[] = [];
  const io: LaunchIo = {
    readText: async () => undefined,
    writeText: async () => undefined,
    exists: async () => false,
    newId: () => "session-1",
    answersHealth: async () => true,
    sleep: async () => undefined,
    now: () => 0,
  };
  const harness: Harness = {
    ...harnessFor(job.harness),
    launchEnvironment: { HARNESS_ENV: "present" },
    clearedEnvironment: ["PARENT_SESSION"],
    conversation: async () => {
      events.push("conversation");
      return { kind: "none" };
    },
    command: (spec) => {
      events.push("command");
      specs.push(spec);
      return ["agent"];
    },
    awaitReady: async (agent) => {
      events.push("ready");
      started.push(agent);
    },
  };
  const deps: WorkerAgentDependencies = {
    run: async (request) => {
      events.push(request.argv[0] ?? "");
      requests.push(request);
      return 0;
    },
    runCommand: async () => {
      events.push("git");
      return { code: 0, stdout: "/project/.git\n", stderr: "" };
    },
    launchContext: () => {
      events.push("context");
      return { io, home: root };
    },
  };
  return { job, jobPath: join(root, "job.json"), harness, deps, events, requests, specs, started };
}

test("worker agent runs setup before resolving launch context and carries current inbox instructions once", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-agent-"));
  try {
    const f = fixture(root);
    const messages = [
      {
        id: "message-1",
        revision: 2,
        kind: "instruction" as const,
        text: "Keep the launch path stable.",
        createdAt: "2030-01-01T00:00:00.000Z",
      },
    ];
    const communication = {
      inboxPath: join(root, "inbox.json"),
      receiptPath: join(root, "receipt.json"),
      initialRevision: 1,
    };
    await writeFile(
      communication.inboxPath,
      JSON.stringify({
        schemaVersion: 1,
        taskId: f.job.taskId,
        revision: 2,
        messages,
      }),
    );
    const job = {
      ...f.job,
      communication,
      setup: [{ name: "install", argv: ["bun", "install"], timeoutMs: 5000 }],
    };
    expect(await runWorkerAgent({ ...f, job }, f.deps)).toBe(0);
    expect(f.events).toEqual([
      "bun",
      "context",
      "conversation",
      "command",
      "git",
      "agent",
      "ready",
    ]);
    expect(f.requests[0]).toEqual({ argv: ["bun", "install"], cwd: root, timeoutMs: 5000 });
    const marker = formatTaskMessages(job.taskId, 2, messages);
    const prompt = `${job.prompt}\n\n${marker}`;
    expect(f.specs[0]?.prompt).toBe(prompt);
    expect(f.requests[1]).toMatchObject({
      cwd: root,
      unset: ["PARENT_SESSION"],
      env: {
        HARNESS_ENV: "present",
        [WORKER_JOB_PATH_ENV]: f.jobPath,
        [WORKER_CONTROL_ENV]: JSON.stringify({
          schemaVersion: 1,
          jobId: job.id,
          taskId: job.taskId,
          generation: job.generation,
          ...communication,
        }),
      },
    });
    expect(f.started[0]?.repo).toBe("/project");
    await runWorkerAgent({ ...f, job: { ...job, prompt } }, f.deps);
    expect(f.specs[1]?.prompt).toBe(prompt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker agent refuses missing, foreign, and stale inboxes before initializing a launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-agent-"));
  try {
    const f = fixture(root);
    const job = {
      ...f.job,
      communication: {
        inboxPath: join(root, "inbox.json"),
        receiptPath: join(root, "receipt.json"),
        initialRevision: 1,
      },
    };
    await expect(runWorkerAgent({ ...f, job }, f.deps)).rejects.toThrow(
      "configured task communication inbox is missing",
    );
    for (const [taskId, revision, reason] of [
      ["another-task", 0, "belongs to a different task"],
      [job.taskId, 0, "is older than the worker snapshot"],
    ] as const) {
      await writeFile(
        job.communication.inboxPath,
        JSON.stringify({
          schemaVersion: 1,
          taskId,
          revision,
          messages: [],
        }),
      );
      await expect(runWorkerAgent({ ...f, job }, f.deps)).rejects.toThrow(
        `configured task communication inbox ${reason}`,
      );
    }
    expect(f.events).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker agent stops and joins the process before reporting a readiness failure", async () => {
  const f = fixture();
  const failure = new Error("plugin never became ready");
  let stopped = false;
  let joined = false;
  const deps = {
    ...f.deps,
    run: (request: Parameters<RunInteractive>[0]) =>
      new Promise<number>((resolve) => {
        request.signal?.addEventListener("abort", () => {
          stopped = true;
          resolve(143);
        });
      }).then((code) => {
        joined = true;
        return code;
      }),
  };
  const harness = {
    ...f.harness,
    awaitReady: async () => {
      throw failure;
    },
  };
  await expect(runWorkerAgent({ ...f, harness }, deps)).rejects.toBe(failure);
  expect(stopped).toBe(true);
  expect(joined).toBe(true);
});

test("worker agent ending first cancels its ready wait and keeps the process outcome", async () => {
  const f = fixture();
  const harness = {
    ...f.harness,
    awaitReady: async (_started: StartedAgent, _io: LaunchIo, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve());
      });
    },
  };
  expect(await runWorkerAgent({ ...f, harness }, { ...f.deps, run: async () => 9 })).toBe(9);
  const failure = new Error("process failed");
  await expect(
    runWorkerAgent(
      { ...f, harness },
      {
        ...f.deps,
        run: async () => {
          throw failure;
        },
      },
    ),
  ).rejects.toBe(failure);
});

test("PR review agents use their own tools and fall back to the worktree when git cannot identify the project", async () => {
  const f = fixture();
  const job = { ...f.job, role: "scout" as const, prReview: { structuredReport: true } };
  for (const runCommand of [
    async () => ({ code: 1, stdout: "", stderr: "not a repository" }),
    async () => {
      throw new Error("git unavailable");
    },
  ]) {
    await runWorkerAgent({ ...f, job }, { ...f.deps, runCommand });
  }
  expect(f.specs.map((spec) => spec.agent)).toEqual(["pr-reviewer", "pr-reviewer"]);
  expect(f.started.map((agent) => agent.repo)).toEqual([job.cwd, job.cwd]);
  expect(f.requests[0]?.env).toEqual({ HARNESS_ENV: "present", [WORKER_JOB_PATH_ENV]: f.jobPath });
});
