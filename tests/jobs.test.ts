import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, CommandResult, ReviewResult } from "../src/contracts.ts";
import {
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  readWorkerResult,
  type WorkerJob,
  type WorkerResult,
} from "../src/jobs.ts";
import { runWorkerJob } from "../src/worker.ts";

const fixedFinishedAt = "2030-01-02T03:04:05.000Z";

function makeJob(root: string, role: WorkerJob["role"] = "scout"): WorkerJob {
  const base = {
    schemaVersion: 1 as const,
    id: "job-1",
    taskId: "task-1",
    generation: 3,
    role,
    cwd: root,
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" as const },
    prompt: "Complete the approved worker brief.",
    resultPath: join(root, "result.json"),
    timeoutMs: 15_000,
  };
  return role === "reviewer" || role === "verifier"
    ? { ...base, review: { head: "abc123", lens: "behavior" as const } }
    : base;
}

function assistantMessage(text: string, stopReason: "stop" | "aborted" | "error" = "stop") {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text },
    ],
    stopReason,
  };
}

function assistantEvent(
  text: string,
  type: "message_end" | "agent_end" = "message_end",
  willContinue?: boolean,
): string {
  const message = assistantMessage(text);
  return type === "agent_end"
    ? JSON.stringify({
        type,
        messages: [message],
        ...(willContinue === undefined ? {} : { willContinue }),
      })
    : JSON.stringify({ type, message });
}

function turnEndEvent(text: string, stopReason: "stop" | "aborted" | "error" = "stop"): string {
  return JSON.stringify({
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage(text, stopReason),
    toolResults: [],
  });
}

function commandResult(stdout: string, code = 0): CommandResult {
  return { code, stdout, stderr: "" };
}

test("cancels a worker command before publishing its failure result", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-signal-"));
  try {
    const controller = new AbortController();
    let commandSettled = false;
    let publishedBeforeSettlement = false;
    const persisted: WorkerResult[] = [];
    const command = runWorkerJob(makeJob(root, "implementer"), {
      signal: controller.signal,
      run: async (request) => {
        const signal = request.signal;
        if (signal === undefined) {
          throw new Error("worker command did not receive cancellation signal");
        }
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            commandSettled = true;
            reject(new Error("worker command aborted"));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
        throw new Error("worker command unexpectedly resolved");
      },
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        if (!commandSettled) publishedBeforeSettlement = true;
        persisted.push(value);
      },
    });
    controller.abort("worker interrupted");

    const result = await command;
    expect(commandSettled).toBe(true);
    expect(publishedBeforeSettlement).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("worker command aborted");
    expect(persisted).toEqual([result]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts terminal agent_end text over provisional assistant events", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-"));
  try {
    const job = makeJob(root);
    const stdout = [
      JSON.stringify({ type: "session_start", sessionId: "session-1" }),
      assistantEvent("intermediate text"),
      turnEndEvent("turn text"),
      assistantEvent("final worker report", "agent_end"),
    ].join("\n");
    const written: WorkerResult[] = [];

    const result = await runWorkerJob(job, {
      run: async () => commandResult(stdout),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        written.push(value);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("final worker report");
    expect(result.finishedAt).toBe(fixedFinishedAt);
    expect(written).toEqual([result]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("persists failure when OMP output has no terminal agent_end", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-missing-terminal-"));
  try {
    const stdout = [
      assistantEvent("Outcome: implemented"),
      turnEndEvent("Outcome: implemented"),
    ].join("\n");
    let persisted: WorkerResult | undefined;
    const result = await runWorkerJob(makeJob(root, "implementer"), {
      run: async () => commandResult(stdout),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        persisted = value;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("terminal agent_end");
    expect(result.text).toBe("");
    expect(persisted).toEqual(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists failure when OMP only emits a continuing agent_end", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-continuing-terminal-"));
  try {
    const stdout = [
      assistantEvent("Outcome: implemented"),
      assistantEvent("Outcome: needs-decision", "agent_end", true),
    ].join("\n");
    let persisted: WorkerResult | undefined;
    const result = await runWorkerJob(makeJob(root, "implementer"), {
      run: async () => commandResult(stdout),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        persisted = value;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("terminal agent_end");
    expect(result.text).toBe("");
    expect(persisted).toEqual(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a terminal agent_end without final assistant text", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-empty-terminal-"));
  try {
    const stdout = [
      assistantEvent("Outcome: implemented"),
      JSON.stringify({ type: "agent_end", messages: [assistantMessage("")] }),
    ].join("\n");
    let persisted: WorkerResult | undefined;
    const result = await runWorkerJob(makeJob(root, "implementer"), {
      run: async () => commandResult(stdout),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        persisted = value;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("final assistant text");
    expect(result.text).toBe("");
    expect(persisted).toEqual(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when OMP metadata selects a different model", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-model-"));
  try {
    const message = {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-5.5",
      content: [{ type: "text", text: "report" }],
      stopReason: "stop",
    };
    const result = await runWorkerJob(makeJob(root), {
      run: async () => commandResult(JSON.stringify({ type: "agent_end", messages: [message] })),
      now: () => fixedFinishedAt,
      writeResult: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("selected model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not infer implementation or presentation completion from prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-contracts-"));
  try {
    const incompleteImplementer = await runWorkerJob(makeJob(root, "implementer"), {
      run: async () => commandResult(assistantEvent("I changed the requested files.", "agent_end")),
      now: () => fixedFinishedAt,
      writeResult: () => undefined,
    });
    expect(incompleteImplementer.status).toBe("failed");
    expect(incompleteImplementer.error).toContain("Outcome");

    const incompletePresentation = await runWorkerJob(makeJob(root, "presentation"), {
      run: async () => commandResult(assistantEvent("The page is ready.", "agent_end")),
      now: () => fixedFinishedAt,
      writeResult: () => undefined,
    });
    expect(incompletePresentation.status).toBe("failed");
    expect(incompletePresentation.error).toContain("Artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("keeps reviewer output strict and binds it to the requested identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-review-"));
  try {
    const job = makeJob(root, "reviewer");
    const review: ReviewResult = {
      lens: "behavior",
      head: "abc123",
      generation: 3,
      pass: false,
      findings: [
        {
          id: "finding-1",
          severity: "P1",
          verdict: "confirmed",
          file: "src/worker.ts",
          line: 12,
          description: "The failure is observable at the command boundary.",
        },
      ],
      summary: "One evidence-backed finding requires attention.",
    };
    const written: WorkerResult[] = [];
    const result = await runWorkerJob(job, {
      run: async () => commandResult(assistantEvent(JSON.stringify(review), "agent_end")),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        written.push(value);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.review).toEqual(review);
    expect(written[0]).toEqual(result);

    const staleReview = JSON.stringify({ ...review, head: "different-head" });
    const staleResult = await runWorkerJob(job, {
      run: async () => commandResult(assistantEvent(staleReview, "agent_end")),
      now: () => fixedFinishedAt,
      writeResult: async (_path, value) => {
        written.push(value);
      },
    });
    expect(staleResult.status).toBe("failed");
    expect(staleResult.text).toContain("different-head");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turns malformed, provider-error, aborted, and nonzero runs into durable failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-failures-"));
  try {
    const fixtures: readonly { readonly stdout: string; readonly code?: number }[] = [
      { stdout: "not JSONL" },
      { stdout: JSON.stringify({ type: "provider_error", error: "quota exhausted" }) },
      { stdout: turnEndEvent("aborted worker turn", "aborted") },
      { stdout: assistantEvent("ignored because the process failed", "agent_end"), code: 9 },
    ];
    for (const fixture of fixtures) {
      const job = makeJob(root);
      let persisted: WorkerResult | undefined;
      const result = await runWorkerJob(job, {
        run: async () => commandResult(fixture.stdout, fixture.code ?? 0),
        now: () => fixedFinishedAt,
        writeResult: async (_path, value) => {
          persisted = value;
        },
      });
      expect(result.status).toBe("failed");
      expect(result.error).toBeString();
      expect(persisted).toEqual(result);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires absolute paths and strict result fields at the wire boundary", () => {
  expect(() =>
    parseWorkerJob({
      schemaVersion: 1,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      cwd: "relative/worktree",
      model: { model: "luna", thinking: "max" },
      prompt: "brief",
      resultPath: "/tmp/result.json",
      timeoutMs: 1_000,
    }),
  ).toThrow(TypeError);

  expect(() =>
    parseWorkerJob({
      schemaVersion: 1,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      cwd: process.cwd(),
      model: { model: "luna", thinking: "max" },
      prompt: "brief",
      resultPath: join(process.cwd(), "result.json"),
      timeoutMs: 1_000,
    }),
  ).toThrow("exact provider/model");

  expect(() =>
    parseWorkerResult({
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "reviewer",
      status: "completed",
      text: "{}",
      finishedAt: fixedFinishedAt,
    }),
  ).toThrow(TypeError);

  expect(() =>
    parseWorkerResult({
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      status: "completed",
      text: "ok",
      artifactPath: "relative/report.html",
      finishedAt: fixedFinishedAt,
    }),
  ).toThrow(TypeError);
});

test("atomically writes private results and rejects stale identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-atomic-"));
  try {
    const resultPath = join(root, "nested", "result.json");
    const result: WorkerResult = {
      id: "job-1",
      taskId: "task-1",
      generation: 3,
      role: "scout",
      status: "completed",
      text: "report",
      finishedAt: fixedFinishedAt,
    };
    await persistWorkerResult(resultPath, result);

    const mode = (await stat(resultPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
    expect(await readWorkerResult(resultPath, { id: "job-1", generation: 3 })).toEqual(result);
    await expect(readWorkerResult(resultPath, { id: "job-1", generation: 2 })).rejects.toThrow(
      "stale",
    );

    await chmod(resultPath, 0o644);
    await persistWorkerResult(resultPath, result);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects session directories for non-implementer jobs", () => {
  const root = process.cwd();
  const sessionDirectory = join(root, "implementer-session");
  const freshRoles = ["scout", "reviewer", "verifier", "presentation"] as const;
  for (const role of freshRoles) {
    expect(() =>
      parseWorkerJob({
        ...makeJob(root, role),
        sessionDirectory,
      }),
    ).toThrow("only permitted for implementer");
  }

  expect(() =>
    parseWorkerJob({
      ...makeJob(root, "implementer"),
      sessionDirectory: "relative/session",
    }),
  ).toThrow("absolute path");
});

test("preserves the exact model selector and thinking level for resumed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-selector-"));
  try {
    const model = Object.freeze({
      model: "openai-codex/gpt-5.6-luna",
      thinking: "max" as const,
    });
    const job = Object.freeze({
      ...makeJob(root, "implementer"),
      model,
      sessionDirectory: join(root, "implementer-session"),
    });
    let request: CommandRequest | undefined;
    const result = await runWorkerJob(job, {
      run: async (value) => {
        request = value;
        return commandResult(assistantEvent("Outcome: implemented", "agent_end"));
      },
      now: () => fixedFinishedAt,
      writeResult: () => undefined,
    });

    expect(result.status).toBe("completed");
    if (request === undefined) {
      throw new Error("expected worker command request");
    }
    const modelFlag = request.argv.indexOf("--model");
    const thinkingFlag = request.argv.indexOf("--thinking");
    expect(request.argv[modelFlag + 1]).toBe("openai-codex/gpt-5.6-luna");
    expect(request.argv[thinkingFlag + 1]).toBe("max");
    expect(job.model).toEqual(model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
