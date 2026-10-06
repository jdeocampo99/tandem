import { taskUsageView } from "../../src/runtime/usage-view.ts";
import { taskPageView } from "../../src/tasks/page-view.ts";
import { task } from "../session/fixtures.ts";

/** A real task projection used by the native screen interaction check. */
export function taskScreenFixture(blocked = false) {
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
    requestId: "req-tern",
    pullRequest: {
      number: 281,
      repository: "owner/repo",
      url: "https://github.com/owner/repo/pull/281",
      state: "draft",
      head: "tandem/tern-backend-adapter",
      base: "main",
    },
    createdAt: "2030-01-02T03:04:05.000Z",
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
          charge: {
            provenance: "estimated",
            currency: "USD",
            amountMicros: 1240000,
            pricingSource: "list-price",
            pricingVersion: 1,
          },
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
