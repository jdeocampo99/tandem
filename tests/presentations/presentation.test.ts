import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ModelSpec,
  RepoPolicy,
  ResolvedPolicy,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import type { PresentationAgent } from "../../src/presentations/records.ts";
import {
  buildRevisionBrief,
  openDrawnPresentation,
  preparePresentation,
  readPresentationFeedback,
  writeRevisionBrief,
} from "../../src/presentations/session.ts";
import { presentationRequestStep } from "../../src/presentations/workflow.ts";
import type { WorkerTerminalState } from "../../src/workers/terminal.ts";

const models: Readonly<
  Record<"coordinator" | "scout" | "implementer" | "reviewer" | "presentation", ModelSpec>
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models,
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxFixRounds: 3,
  } satisfies RepoPolicy,
  guidance: {
    implementation: [],
    validation: [],
    review: [],
  },
};

const lease: WorktreeLease = {
  root: "/tmp/treehouse",
  path: "/tmp/task-worktree",
  name: "presentation-task",
  baseHead: "base-1",
  branch: "tandem/presentation-task",
  leaseId: "lease-1",
  leaseHolder: "tandem-1",
  leasedAt: "2030-01-02T03:04:05.000Z",
};

const agent: PresentationAgent = {
  jobId: "scout-job-1",
  jobPath: "/tmp/jobs/task-1/0/scout-job-1/job.json",
  generation: 0,
  cwd: "/tmp/task-worktree",
};

function task(repoPath: string): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath,
    kind: "implementation",
    objective: "Prepare a visual artifact",
    acceptanceCriteria: ["The artifact is useful and complete."],
    surfaces: ["presentation"],
    stage: "ready",
    scopeApproved: true,
    policy,
    createdAt: "2030-01-02T03:04:05.000Z",
    updatedAt: "2030-01-02T03:04:05.000Z",
    worktree: lease,
    generation: 0,
    reviewRound: 0,
    reviewHead: "head-1",
    validationEvidence: [],
    reviews: [],
    notifications: [],
  };
}

async function freshPresentationPaths(
  root: string,
  leaf = "presentation-1",
): Promise<Readonly<{ repository: string; directory: string }>> {
  const repository = join(root, "repo");
  const parent = join(root, "presentation-jobs");
  await mkdir(repository);
  await mkdir(parent);
  return { repository, directory: join(parent, leaf) };
}

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function feedbackResponse(): string {
  return [
    "session:",
    "  status: feedback",
    "  session_ended: false",
    "feedback[0]{message,kind}:",
    "  message: Please review this artifact",
  ].join("\n");
}

function endedResponse(): string {
  return ["session:", "  status: ended", "  session_ended: true"].join("\n");
}

function lavishGuideResult(request: CommandRequest): CommandResult | undefined {
  if (request.argv[1] === "--help") return result("help");
  if (request.argv[1] === "playbook") return result(`playbook ${request.argv[2] ?? ""}`);
  if (request.argv[1] === "design") return result("design guidance");
  return undefined;
}

test("prepares a private directory and a draw request for the research agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (request.argv[1] === "--help") return result("lavish-axi help");
      if (request.argv[1] === "playbook") {
        expect(request.argv[2]).toBe("plan");
        return result("plan playbook guidance");
      }
      if (request.argv[1] === "design") return result("fallback design guidance");
      throw new Error(`unexpected command: ${request.argv.join(" ")}`);
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: ["/tmp/reference.png"],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });

    expect(prepared.status).toBe("running");
    expect(prepared.cwd).toBe(paths.directory);
    expect(prepared.artifactPath).toBe(join(paths.directory, "artifact.html"));
    expect(prepared.agent).toEqual(agent);
    expect(prepared.jobPath).toBeUndefined();
    expect(prepared.request).toEqual({
      id: "request-1",
      kind: "draw",
      briefPath: join(paths.directory, "brief.md"),
      requestedAt: "2030-01-02T03:04:05.000Z",
    });
    const brief = await readFile(join(paths.directory, "brief.md"), "utf8");
    expect(brief).toContain(`Write the complete HTML to exactly ${prepared.artifactPath}`);
    expect(brief).toContain("copy_asset");
    expect(brief).toContain("Do not open Lavish or call submit_report");
    expect(brief).toContain("lavish-axi help");
    expect(brief).toContain("Required plan playbook guidance");
    expect(brief).toContain("fallback design guidance");
    expect(brief).toContain("The artifact is useful and complete.");
    expect(brief).toContain("/tmp/reference.png");
    expect(calls).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("briefs a mockup with the style guide instead of Lavish guidance or task checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-mockup-"));
  try {
    const paths = await freshPresentationPaths(root);
    const run: CommandRunner = async (request) => {
      throw new Error(`unexpected command: ${request.argv.join(" ")}`);
    };
    await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Create four phone-screen mockups of the cancellation flow",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      run,
    });

    const brief = await readFile(join(paths.directory, "brief.md"), "utf8");
    expect(brief).toContain("Mockup style guide (follow it exactly):\n# Mockup style");
    expect(brief).toContain("AGENTS.md and CLAUDE.md");
    expect(brief).not.toContain("The artifact is useful and complete.");
    expect(brief).not.toContain("Lavish guidance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a fresh child through the /tmp physical alias when it is outside the repository", async () => {
  const root = await mkdtemp("/tmp/tandem-presentation-alias-");
  try {
    const paths = await freshPresentationPaths(root);
    const run: CommandRunner = async (request) =>
      lavishGuideResult(request) ?? result("unexpected command");
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });

    expect(prepared.cwd).toBe(paths.directory);
    expect(prepared.artifactPath).toBe(join(paths.directory, "artifact.html"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies the expected regular artifact before opening Lavish and preserves observation status", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      expect(request.argv).toEqual(["lavish-axi", join(paths.directory, "artifact.html")]);
      return result(feedbackResponse());
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<!doctype html><title>Artifact</title>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });

    expect(opened.status).toBe("open");
    expect(opened.observation?.status).toBe("feedback");
    expect(opened.observation?.rawFeedback).toContain("Please review this artifact");
    expect(calls).toHaveLength(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("preserves a known session URL when later observations omit it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root, "presentation-url");
    const sessionUrl = "http://127.0.0.1:4567/presentation";
    const run: CommandRunner = async (request) => {
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      if (request.argv[1] === "poll") {
        return result("session:\n  status: waiting\n  session_ended: false\n");
      }
      return result(
        ["session:", "  status: opened", "  session_ended: false", `  url: ${sessionUrl}`].join(
          "\n",
        ),
      );
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-url",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<html>ok</html>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    expect(opened.sessionUrl).toBe(sessionUrl);
    const waiting = await readPresentationFeedback({
      record: opened,
      clock: () => "2030-01-02T03:04:08.000Z",
      run,
    });
    expect(waiting.sessionUrl).toBe(sessionUrl);
    expect(waiting.observation?.status).toBe("waiting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a native feedback payload when cancellation arrives after the response", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root, "presentation-late-abort");
    const controller = new AbortController();
    const run: CommandRunner = async (request) => {
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      if (request.argv[1] === "poll") {
        controller.abort(new Error("late cancellation"));
        return result(feedbackResponse());
      }
      return result(feedbackResponse());
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-late-abort",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<html>ok</html>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    const observed = await readPresentationFeedback({
      record: opened,
      clock: () => "2030-01-02T03:04:08.000Z",
      run,
      signal: controller.signal,
    });
    expect(observed).not.toBe(opened);
    expect(observed.observation?.status).toBe("feedback");
    expect(observed.observation?.rawFeedback).toContain("Please review this artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails a draw whose artifact is missing or a symlink out of the folder, without opening Lavish", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const opens: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      opens.push(request);
      return result(feedbackResponse());
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    const missing = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain("without writing the page");

    const outside = join(root, "outside.html");
    await writeFile(outside, "<html>outside</html>", "utf8");
    await symlink(outside, prepared.artifactPath);
    const escaped = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:08.000Z",
      run,
    });
    expect(escaped.status).toBe("failed");
    expect(opens).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a pre-positioned artifact symlink before writing the brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    await mkdir(paths.directory);
    const outside = join(root, "outside.html");
    const original = "<html>outside</html>";
    await writeFile(outside, original, "utf8");
    await symlink(outside, join(paths.directory, "artifact.html"));
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return result("unexpected command");
    };

    await expect(
      preparePresentation({
        task: task(paths.repository),
        id: "presentation-1",
        requestId: "request-1",
        agent,
        directory: paths.directory,
        objective: "Show the approved work clearly",
        artifacts: [],
        now: "2030-01-02T03:04:05.000Z",
        timeoutMs: 10_000,
        run,
      }),
    ).rejects.toThrow("freshly created");
    expect(await readFile(outside, "utf8")).toBe(original);
    expect(calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a stale brief without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    await mkdir(paths.directory);
    const staleBrief = "stale brief\n";
    await writeFile(join(paths.directory, "brief.md"), staleBrief, "utf8");
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return result("unexpected command");
    };

    await expect(
      preparePresentation({
        task: task(paths.repository),
        id: "presentation-1",
        requestId: "request-1",
        agent,
        directory: paths.directory,
        objective: "Show the approved work clearly",
        artifacts: [],
        now: "2030-01-02T03:04:05.000Z",
        timeoutMs: 10_000,
        run,
      }),
    ).rejects.toThrow("freshly created");
    expect(await readFile(join(paths.directory, "brief.md"), "utf8")).toBe(staleBrief);
    expect(calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a physical parent alias into the source repository before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const sourceAlias = join(root, "source-alias");
    await symlink(paths.repository, sourceAlias);
    const directory = join(sourceAlias, "presentation-1");
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return result("unexpected command");
    };

    await expect(
      preparePresentation({
        task: task(paths.repository),
        id: "presentation-1",
        requestId: "request-1",
        agent,
        directory,
        objective: "Show the approved work clearly",
        artifacts: [],
        now: "2030-01-02T03:04:05.000Z",
        timeoutMs: 10_000,
        run,
      }),
    ).rejects.toThrow("physical source repository");
    await expect(lstat(join(paths.repository, "presentation-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performs one cancellable poll per feedback request and preserves meaningful transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  const pollGate = Promise.withResolvers<void>();
  try {
    const paths = await freshPresentationPaths(root);
    const calls: CommandRequest[] = [];
    let pollCount = 0;
    let feedbackNow = "2030-01-02T03:04:08.000Z";
    const run: CommandRunner = async (request) => {
      calls.push(request);
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      if (request.argv[1] !== "poll") return result(feedbackResponse());
      pollCount += 1;
      if (pollCount === 1) {
        await pollGate.promise;
        return result(feedbackResponse());
      }
      return result(endedResponse());
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<html>ok</html>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    const feedbackPromise = readPresentationFeedback({
      record: opened,
      clock: () => feedbackNow,
      run,
    });
    await Promise.resolve();
    feedbackNow = "2030-01-02T03:04:09.000Z";
    pollGate.resolve();
    const feedback = await feedbackPromise;
    expect(feedback.updatedAt).toBe("2030-01-02T03:04:09.000Z");
    expect(feedback.status).toBe("open");
    expect(feedback.observation?.status).toBe("feedback");
    expect(feedback.observation?.raw).toContain("feedback[0]");

    const ended = await readPresentationFeedback({
      record: feedback,
      clock: () => "2030-01-02T03:04:09.000Z",
      run,
    });
    expect(ended.status).toBe("ended");
    expect(ended.observation?.sessionEnded).toBe(true);
    const callsBeforeTerminalRead = calls.length;
    const unchanged = await readPresentationFeedback({
      record: ended,
      clock: () => "2030-01-02T03:04:10.000Z",
      run,
    });
    expect(unchanged).toBe(ended);
    expect(calls).toHaveLength(callsBeforeTerminalRead);
  } finally {
    pollGate.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
test("keeps an open presentation resumable when its poll command times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const run: CommandRunner = async (request) => {
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      if (request.argv[1] !== "poll") return result(feedbackResponse());
      const timeout = new Error("poll timed out");
      timeout.name = "CommandTimeoutError";
      Object.assign(timeout, { request });
      throw timeout;
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-timeout",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<html>ok</html>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    const unchanged = await readPresentationFeedback({
      record: opened,
      clock: () => "2030-01-02T03:04:08.000Z",
      run,
    });
    expect(unchanged).toBe(opened);
    expect(unchanged.status).toBe("open");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not start a poll when cancellation is already requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-"));
  try {
    const paths = await freshPresentationPaths(root);
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      const guidance = lavishGuideResult(request);
      if (guidance !== undefined) return guidance;
      return result(feedbackResponse());
    };
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      timeoutMs: 10_000,
      run,
    });
    await writeFile(prepared.artifactPath, "<html>ok</html>", "utf8");
    const opened = await openDrawnPresentation({
      record: prepared,
      now: "2030-01-02T03:04:07.000Z",
      run,
    });
    const controller = new AbortController();
    controller.abort(new Error("user cancelled feedback"));
    const unchanged = await readPresentationFeedback({
      record: opened,
      clock: () => "2030-01-02T03:04:08.000Z",
      run,
      signal: controller.signal,
    });
    expect(unchanged).toBe(opened);
    expect(calls).toHaveLength(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes each Lavish comment as its own revision brief that edits the same page", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-presentation-revision-"));
  try {
    const paths = await freshPresentationPaths(root);
    const run: CommandRunner = async (request) =>
      lavishGuideResult(request) ?? result("unexpected command");
    const prepared = await preparePresentation({
      task: task(paths.repository),
      id: "presentation-1",
      requestId: "request-1",
      agent,
      directory: paths.directory,
      objective: "Show the approved work clearly",
      artifacts: [],
      now: "2030-01-02T03:04:05.000Z",
      run,
    });
    const briefPath = await writeRevisionBrief(prepared, "request-2", "Add a sad JR on screen 2");
    expect(briefPath).toBe(join(paths.directory, "revision-request-2.md"));
    const brief = await readFile(briefPath, "utf8");
    expect(brief).toBe(buildRevisionBrief(prepared.artifactPath, "Add a sad JR on screen 2"));
    expect(brief).toContain("Add a sad JR on screen 2");
    expect(brief).toContain(`Update ${prepared.artifactPath} in place`);
    await expect(writeRevisionBrief(prepared, "request-2", "again")).rejects.toThrow();
    await expect(writeRevisionBrief(prepared, "../escape", "x")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pending request is sent only to a finished, idle agent and ends when its turn settles", () => {
  const now = Date.parse("2030-01-02T03:04:05.000Z");
  const terminal: WorkerTerminalState = {
    schemaVersion: 1,
    jobId: agent.jobId,
    taskId: "task-1",
    generation: 0,
    role: "scout",
    cwd: agent.cwd,
    pid: 1,
    phase: "idle",
    completed: true,
    heartbeatAt: "2030-01-02T03:04:04.000Z",
  };
  const request = { id: "request-1" };
  expect(presentationRequestStep(request, terminal, now)).toBe("send");
  expect(presentationRequestStep(request, { ...terminal, completed: false }, now)).toBe("wait");
  expect(presentationRequestStep(request, { ...terminal, phase: "busy" }, now)).toBe("wait");
  expect(
    presentationRequestStep(request, { ...terminal, phase: "busy", commandId: "request-1" }, now),
  ).toBe("drawing");
  expect(
    presentationRequestStep(request, { ...terminal, settledCommandId: "request-1" }, now),
  ).toBe("finished");
  expect(presentationRequestStep(request, undefined, now)).toBe("gone");
  expect(presentationRequestStep(request, { ...terminal, phase: "closed" }, now)).toBe("gone");
  expect(
    presentationRequestStep(request, { ...terminal, heartbeatAt: "2030-01-02T03:03:00.000Z" }, now),
  ).toBe("gone");
});
