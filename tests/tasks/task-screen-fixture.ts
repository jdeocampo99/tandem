import {
  type NativeViews,
  type NativeViewsPublication,
  nativeBriefFile,
  nativePrFile,
  nativeTaskFile,
} from "../../src/board/native-views.ts";
import { prPaneView } from "../../src/pr-review/native-view.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { briefView } from "../../src/requests/native-view.ts";
import { taskUsageView, usageView } from "../../src/runtime/usage-view.ts";
import { taskPageView } from "../../src/tasks/page-view.ts";
import { content } from "../board/fixtures.ts";
import { task } from "../session/fixtures.ts";

/** A real task projection used by the native screen interaction check. */
export function taskScreenFixture(blocked = false, linked = true) {
  const record = task({
    id: "102",
    title: "Tern backend adapter",
    objective:
      "Add the Tern terminal backend with safe pane ownership. Preserve the coordinator conversation and prove the native screens in isolation.",
    stage: blocked ? "blocked" : "awaiting-fixes",
    previousStage: "awaiting-fixes",
    reviewRound: 1,
    blockReason:
      "Review found the same 2 problems twice. The fix did not change the result, so Tandem stopped retrying on its own.",
    ...(linked
      ? {
          requestId: "req-tern",
          pullRequest: {
            number: 281,
            repository: "owner/repo",
            url: "https://github.com/owner/repo/pull/281",
            state: "draft" as const,
            head: "tandem/tern-backend-adapter",
            base: "main",
          },
        }
      : {}),
    createdAt: "2030-01-02T03:04:05.000Z",
    findingLedger: [
      {
        id: "close-guard",
        lens: "review",
        severity: "P1",
        verdict: "confirmed",
        description: "Closing by title could target an unrelated pane. Match the exact pane id.",
        file: "adapter.ts",
        line: 12,
        status: "unresolved",
        raisedAt: { head: "abc123", generation: 0, reviewRound: 1 },
        statusAt: { head: "abc123", generation: 0, reviewRound: 1 },
      },
    ],
    validationEvidence: [
      {
        name: "bun run check",
        exitCode: 0,
        head: "abc123",
        contract: "final",
        argv: ["bun", "run", "check"],
        stdout: "",
        stderr: "",
        origin: "local",
        policyDigest: "fixture",
      },
      {
        name: "bun test close guard",
        exitCode: 1,
        head: "abc123",
        contract: "final",
        argv: ["bun", "test", "close-guard"],
        stdout: "",
        stderr: "Pane identity mismatch",
        origin: "local",
        policyDigest: "fixture",
      },
    ],
  });
  return taskPageView({
    task: record,
    now: "2030-01-02T03:16:05.000Z",
    model: "claude-code/opus",
    unreadableEvents: 0,
    cost: taskUsageView("102", {
      malformedEvents: 0,
      events: [
        {
          schemaVersion: 1,
          eventKey: "task-102-work",
          kind: "work",
          workKind: "implementation",
          identity: { taskId: "102", provider: "claude-code", model: "opus" },
          startedAt: "2030-01-02T03:04:05.000Z",
          endedAt: "2030-01-02T03:16:05.000Z",
          status: "succeeded",
          tokens: { provenance: "unavailable", reason: "provider-did-not-report" },
          charge: { provenance: "unavailable", reason: "provider-did-not-report" },
          quota: { provenance: "unavailable", reason: "no-quota-contract" },
        },
      ],
    }),
    inspection: {
      taskId: record.id,
      stage: record.stage,
      generation: record.generation,
      reviewRound: 1,
      codeFixRounds: { used: 1, remaining: 1, max: 2 },
      review: { exactHead: false, clean: true, unmerged: false },
      repository: { recordedPath: record.repoPath, identity: "proven" },
      branch: "tandem/tern-backend-adapter",
      worktree: { preserved: true },
      lease: { state: "none" },
      endpoints: [],
      jobs: [],
      artifacts: [],
      reservations: [],
      operations: [],
      blocked,
      safetyReasons: [],
    },
    activity: {
      tool: "edit",
      toolTarget: "src/terminal-backend/tern/adapter.ts",
      toolStartedAt: "2030-01-02T03:16:01.000Z",
      todos: [
        { content: "Read the terminal contract", status: "completed" },
        { content: "Build the Tern backend", status: "completed" },
        { content: "Prove exact pane ownership", status: "completed" },
        { content: "Fix the close guard", status: "in_progress" },
        { content: "Run validation and review", status: "pending" },
      ],
    },
    timeline: [
      {
        taskId: "102",
        seq: 1,
        at: "2030-01-02T03:04:05.000Z",
        type: "created",
        stage: "implementing",
      },
      {
        taskId: "102",
        seq: 2,
        at: "2030-01-02T03:10:05.000Z",
        type: "stage-changed",
        from: "implementing",
        to: "validating",
      },
      {
        taskId: "102",
        seq: 3,
        at: "2030-01-02T03:11:05.000Z",
        type: "stage-changed",
        from: "validating",
        to: "reviewing",
      },
      {
        taskId: "102",
        seq: 4,
        at: "2030-01-02T03:12:05.000Z",
        type: "stage-changed",
        from: "reviewing",
        to: "awaiting-fixes",
      },
      {
        taskId: "102",
        seq: 5,
        at: "2030-01-02T03:12:05.000Z",
        type: "fix-round",
        round: 1,
        generation: 0,
        findingIds: [],
      },
    ],
  });
}

export function taskScreenPublication(project: string, review = false): NativeViewsPublication {
  const taskView = taskScreenFixture();
  const brief = briefView(
    createRequestBriefRecord(
      {
        id: "req-tern",
        repoPath: project,
        content: {
          ...content("Add a native Tern terminal backend"),
          scope: ["Preserve the live coordinator", "Show native task progress"],
          acceptanceCriteria: ["Ownership checks refuse unrelated panes"],
        },
      },
      "2030-01-02T03:04:05.000Z",
    ),
  );
  const pr = prPaneView({
    ...(review
      ? {
          review: {
            taskId: "102",
            generation: 1,
            head: "abc123",
            currentHead: "abc123",
            posted: false,
            intent: "Confirm exact pane ownership before approving.",
            summary: "",
            drafts: [],
            concerns: [],
            notes: [],
          },
        }
      : {}),
    taskId: "102",
    cached: {
      repo: "owner/repo",
      number: 281,
      title: "Tern backend adapter",
      url: "https://github.com/owner/repo/pull/281",
      head: "abc123",
      draft: true,
      body: "## What this does\n\nAdds the Tern backend with exact pane ownership.",
      commits: 3,
      additions: 2,
      deletions: 1,
      readAt: "2030-01-02T03:16:05.000Z",
      checks: [{ name: "TypeScript", state: "passed" }],
      conversation: [],
      threads: [],
      tour: [],
      patch:
        "diff --git a/adapter.ts b/adapter.ts\n--- a/adapter.ts\n+++ b/adapter.ts\n@@ -1,1 +1,2 @@\n-const terminal = herdr();\n+const terminal = tern();\n+export { terminal };\n",
    },
  });
  const at = new Date().toISOString();
  const taskFile = nativeTaskFile("102"),
    briefFile = nativeBriefFile("req-tern"),
    prFile = nativePrFile("owner/repo", 281);
  const panelRow = {
    key: "102",
    title: taskView.header.title,
    state: "blue" as const,
    stage: "fixing",
    time: "12m",
    model: "opus",
    detail: "edit adapter.ts",
    secondary: "opus · editing adapter.ts",
    target: { kind: "task" as const, taskId: "102" },
  };
  const projectRow = {
    terminal: "tern" as const,
    repoPath: project,
    name: "tandem",
    current: true,
    offline: false,
    running: 1,
    needsYou: 0,
    status: "1 running",
    shortcut: "1",
  };
  const bundle: NativeViews = {
    version: 1,
    project,
    writtenAt: at,
    summary: {
      terminal: "tern",
      repoPath: project,
      name: "tandem",
      writtenAt: at,
      running: 1,
      needsYou: 0,
      ready: 0,
      done: 0,
    },
    changeSignature: "fixture",
    panel: {
      header: {
        title: "tandem",
        project,
        projects: [projectRow],
        otherProjectsNeedYou: 0,
        bellCount: 0,
      },
      sections: [
        { title: "Needs you", count: 0, rows: [] },
        { title: "Running", count: 1, rows: [panelRow] },
        { title: "Ready", count: 0, rows: [] },
        { title: "Recently done", count: 0, rows: [] },
      ],
    },
    projects: [projectRow],
    tasks: {
      "102": {
        taskId: "102",
        title: taskView.header.title,
        stage: "awaiting-fixes",
        createdAt: at,
        updatedAt: at,
        model: "claude-code/opus",
        unpricedSamples: 0,
        detailFile: taskFile,
      },
      "103": {
        taskId: "103",
        title: "Fix the settings page",
        stage: "ready",
        createdAt: at,
        updatedAt: at,
        unpricedSamples: 0,
        detailFile: nativeTaskFile("103"),
      },
    },
    briefs: {
      "req-tern": {
        requestId: brief.requestId,
        title: brief.title,
        revision: brief.revision,
        changes: brief.changes,
        approvalState: brief.approvalState,
        abandoned: false,
        commentCount: 0,
        detailFile: briefFile,
      },
    },
    pullRequests: {
      "owner/repo#281": { header: pr.header, readAt: pr.readAt, detailFile: prFile },
    },
    board: { viewOnly: true, returnLabel: "← Orchestrator", lanes: [] },
    usage: usageView({
      now: at,
      todayStart: at,
      weekStart: at,
      limits: [],
      readout: { events: [], malformedEvents: 0 },
      finished: [],
    }),
    catchup: {
      project,
      merged: [],
      needsYou: [],
      blocked: [],
      whereWeLeftOff: [],
      workstreams: [],
      actions: ["open-needs-you", "dismiss"],
    },
    warnings: [],
  };
  return {
    bundle,
    details: [
      { file: taskFile, view: { version: 1, project, kind: "task", data: taskView } },
      { file: briefFile, view: { version: 1, project, kind: "brief", data: brief } },
      { file: prFile, view: { version: 1, project, kind: "pr", data: pr } },
    ],
  };
}
