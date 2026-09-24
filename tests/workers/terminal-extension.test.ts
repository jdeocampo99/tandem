import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import {
  copyMockupAsset,
  idleAfterResult,
  isBackgroundResultWake,
  mockupWriteDecision,
  planAbortWithReason,
  reviewSummary,
  turnStalled,
  userInterruptedTurn,
} from "../../src/workers/terminal-extension.ts";

function job(): WorkerJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "implementer",
    cwd: "/tmp/worktree",
    model: { model: "test/model", thinking: "low" },
    prompt: "implement the change",
    resultPath: "/tmp/worktree/result.json",
  };
}

test("planAbortWithReason persists a durable failure carrying the real reason", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: false },
    "interactive worker heartbeat could not be persisted: ENOSPC",
  );
  expect(plan.shouldPersistResult).toBe(true);
  expect(plan.result?.status).toBe("failed");
  expect(plan.result?.error).toBe("interactive worker heartbeat could not be persisted: ENOSPC");
  expect(plan.result?.id).toBe("job-1");
  expect(plan.result?.taskId).toBe("task-1");
  expect(plan.result?.generation).toBe(0);
  expect(plan.result?.role).toBe("implementer");
});

test("planAbortWithReason never publishes a second result once one is already published", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: true, delegatedSettled: false },
    "interactive worker control polling failed: ECONNRESET",
  );
  expect(plan.shouldPersistResult).toBe(false);
  expect(plan.result).toBeUndefined();
});

test("planAbortWithReason never publishes once a delegated agent-end already settled", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: true },
    "interactive worker heartbeat could not be persisted: EIO",
  );
  expect(plan.shouldPersistResult).toBe(false);
  expect(plan.result).toBeUndefined();
});

test("planAbortWithReason carries the reason through untouched, not a bare 'aborted'", () => {
  const reason = "interactive worker control polling failed: the pane socket closed unexpectedly";
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: false },
    reason,
  );
  expect(plan.result?.error).toBe(reason);
  expect(plan.result?.error).not.toBe("aborted");
});

function agentEnd(stopReason: string): unknown {
  return { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason }] };
}

test("an Esc the extension did not request hands the worker to the person, not a failure", () => {
  expect(userInterruptedTurn(agentEnd("aborted"), false)).toBe(true);
});

test("an abort the extension requested still settles as a failure", () => {
  expect(userInterruptedTurn(agentEnd("aborted"), true)).toBe(false);
});

test("provider errors and normal turn ends are not user interrupts", () => {
  expect(userInterruptedTurn(agentEnd("error"), false)).toBe(false);
  expect(userInterruptedTurn(agentEnd("stop"), false)).toBe(false);
});

test("only a finished background command's wake-up counts as a background wake", () => {
  const assistant = { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage;
  const backgroundResult = {
    role: "custom",
    customType: "async-result",
    content: "bg_1 finished",
    display: true,
    timestamp: 2,
  } as unknown as AgentMessage;
  const typed = { role: "user", content: "one more thing", timestamp: 3 } as AgentMessage;
  const inbox = { ...typed, synthetic: true } as AgentMessage;

  expect(isBackgroundResultWake([assistant, backgroundResult])).toBe(true);
  // Tandem's inbox rendering is appended as a synthetic message and is not a new request.
  expect(isBackgroundResultWake([assistant, backgroundResult, inbox])).toBe(true);
  expect(isBackgroundResultWake([assistant, backgroundResult, typed])).toBe(false);
  expect(isBackgroundResultWake([assistant, inbox])).toBe(false);
  expect(isBackgroundResultWake([])).toBe(false);
});

test("a submitted worker OMP keeps idle for the grace period is done despite willContinue", () => {
  // The settings stall: submit_report, then agent_end with willContinue because a backgrounded
  // dev server was still running, then OMP idle with nothing queued from then on.
  const stalled = {
    completed: true,
    phase: "busy" as const,
    ompIdle: true,
    pendingMessages: false,
  };
  const first = idleAfterResult({ ...stalled, idleSince: undefined, now: 0 });
  expect(first).toEqual({ idleSince: 0, settle: false });
  expect(idleAfterResult({ ...stalled, idleSince: 0, now: 29_999 }).settle).toBe(false);
  expect(idleAfterResult({ ...stalled, idleSince: 0, now: 30_000 })).toEqual({
    idleSince: undefined,
    settle: true,
  });
});

test("idle-after-result never settles an unsubmitted, working, or messaged worker", () => {
  const base = { completed: true, phase: "busy" as const, ompIdle: true, pendingMessages: false };
  const later = { idleSince: 0, now: 60_000 };
  const cases = [
    { ...base, completed: false },
    { ...base, phase: "idle" as const },
    { ...base, ompIdle: false },
    { ...base, pendingMessages: true },
  ];
  for (const input of cases) {
    expect(idleAfterResult({ ...input, ...later })).toEqual({
      idleSince: undefined,
      settle: false,
    });
  }
});

test("a submitted review reads as its round, verdict, and one line per finding by severity", () => {
  const summary = reviewSummary(
    {
      lens: "review",
      head: "21260599aae29357e2d6f2ca3bd06ab2d43eeb2e",
      generation: 1,
      pass: false,
      summary: "Long reviewer notes that stay in the durable result.",
      findings: [
        {
          id: "review/tablet",
          severity: "P2",
          verdict: "plausible",
          description: "Tablet-width navigation stacks above the section. More detail follows.",
        },
        {
          id: "review/entrance",
          severity: "P1",
          verdict: "confirmed",
          file: "src/components/motion/page-transition.tsx",
          line: 188,
          description: `Referrals content enters at zero opacity ${"x".repeat(200)}`,
        },
      ],
    },
    2,
  );
  const lines = summary.split("\n");
  expect(lines[0]).toBe("Review round 2: changes needed, 2 findings");
  expect(lines[1]).toStartWith("- P1 Referrals content enters at zero opacity");
  expect(lines[1]).toContain("…");
  expect(lines[1]).toEndWith("(src/components/motion/page-transition.tsx:188)");
  expect(lines[2]).toBe("- P2 Tablet-width navigation stacks above the section. [unconfirmed]");
  expect(summary).not.toContain("21260599");
  expect(summary).not.toContain("generation");
});

test("a clean review, or one from a job without a round, still reads plainly", () => {
  const clean = {
    lens: "review" as const,
    head: "head",
    generation: 0,
    pass: true,
    summary: "",
    findings: [],
  };
  expect(reviewSummary(clean, 1)).toBe("Review round 1: approved, no findings.");
  expect(reviewSummary(clean, undefined)).toBe("Review: approved, no findings.");
  const knownIssueOnly = {
    ...clean,
    pass: false,
    findings: [
      { id: "f", severity: "P2" as const, verdict: "confirmed" as const, description: "Minor." },
    ],
  };
  expect(reviewSummary(knownIssueOnly, 1)).toBe("Review round 1: approved, 1 finding\n- P2 Minor.");
});

test("a turn with no tool activity for five minutes is stalled", () => {
  const quiet = { turnActive: true, toolsRunning: 0, lastActivityAt: 0 };
  expect(turnStalled({ ...quiet, now: 5 * 60_000 - 1 })).toBe(false);
  expect(turnStalled({ ...quiet, now: 5 * 60_000 })).toBe(true);
});

test("a running tool or a finished turn is never stalled", () => {
  const late = { lastActivityAt: 0, now: 60 * 60_000 };
  expect(turnStalled({ ...late, turnActive: true, toolsRunning: 1 })).toBe(false);
  expect(turnStalled({ ...late, turnActive: false, toolsRunning: 0 })).toBe(false);
});

test("a scout writes only inside the mockup folder it was asked to draw in", () => {
  const base = { role: "scout", cwd: "/tmp/worktree" } as const;
  const artifactDir = "/tmp/presentations/p-1";
  expect(
    mockupWriteDecision({ ...base, toolName: "read", toolInput: {}, artifactDir: undefined }),
  ).toBeUndefined();
  expect(
    mockupWriteDecision({
      ...base,
      toolName: "write",
      toolInput: { path: `${artifactDir}/artifact.html` },
      artifactDir: undefined,
    }),
  ).toMatchObject({ block: true });
  expect(
    mockupWriteDecision({
      ...base,
      toolName: "write",
      toolInput: { path: `${artifactDir}/artifact.html` },
      artifactDir,
    }),
  ).toBe("allow");
  for (const path of ["src/app.ts", "/tmp/presentations/p-10/artifact.html", "xd://mcp__tool"]) {
    expect(
      mockupWriteDecision({ ...base, toolName: "edit", toolInput: { path }, artifactDir }),
    ).toMatchObject({ block: true });
  }
  expect(mockupWriteDecision({ ...base, toolName: "copy_asset", toolInput: {}, artifactDir })).toBe(
    "allow",
  );
  expect(
    mockupWriteDecision({
      role: "implementer",
      cwd: "/tmp/worktree",
      toolName: "write",
      toolInput: { path: "src/app.ts" },
      artifactDir: undefined,
    }),
  ).toBeUndefined();
});

test("copy_asset copies a checkout file byte for byte and refuses anything outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-copy-asset-"));
  try {
    const cwd = join(root, "worktree");
    const artifactDir = join(root, "presentation");
    await mkdir(join(cwd, "public"), { recursive: true });
    await mkdir(artifactDir);
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
    await writeFile(join(cwd, "public", "jr.webp"), bytes);
    const target = await copyMockupAsset({
      cwd,
      artifactDir,
      from: "public/jr.webp",
      name: "jr.webp",
    });
    expect(target).toBe(join(artifactDir, "jr.webp"));
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);

    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(cwd, "public", "link.txt"));
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "../secret.txt", name: "secret.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/link.txt", name: "link.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/jr.webp", name: "../jr.webp" }),
    ).rejects.toThrow("plain file name");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public", name: "dir" }),
    ).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
