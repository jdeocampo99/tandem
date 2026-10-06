import type { NativeBoardCard } from "../../src/board/native.ts";
import type { NativeViews } from "../../src/board/native-views.ts";
import { usageDisplay } from "../../src/runtime/usage-display.ts";
import type { UsageView } from "../../src/runtime/usage-view.ts";

const project = "/fixture/tandem";
const writtenAt = "2030-01-02T12:00:00Z";
const totals = (costMicros: number, agentMs = 0, tasksDone = 0) => ({
  costMicros,
  agentMs,
  tasksDone,
  unpricedSamples: 0,
});
function card(
  id: string,
  title: string,
  detail: string,
  time: string,
  model: string,
  costLabel: string,
  pr?: number,
): NativeBoardCard {
  return {
    key: `task:${id}`,
    title,
    state: "blue",
    stage: "implementing",
    time,
    model,
    detail,
    secondary: detail,
    target: { kind: "task", taskId: id },
    harness: model === "opus" ? "claude-code" : "omp",
    harnessGlyph: model === "opus" ? "✻" : "ω",
    branch: `tandem/${id}`,
    costLabel,
    unpricedSamples: 0,
    stuck: id === "fix-panel-width",
    ...(pr === undefined
      ? {}
      : {
          pullRequest: {
            repo: "acme/app",
            number: pr,
            draft: pr !== 278,
            url: `https://github.com/acme/app/pull/${pr}`,
          },
        }),
  };
}

/** Synthetic, realistic records only. No process environment or provider payloads enter fixtures. */
export function nativeScreensFixture(): NativeViews {
  const usage: UsageView = {
    limits: [
      {
        provider: "Claude Max",
        account: "personal",
        window: "five-hour",
        label: "5-hour",
        remainingPercent: 62,
        resetInMs: 8_040_000,
        fetchedAt: writtenAt,
      },
      {
        provider: "Claude Max",
        account: "personal",
        window: "weekly",
        label: "Weekly",
        remainingPercent: 71,
        resetInMs: 280_800_000,
        fetchedAt: writtenAt,
      },
      {
        provider: "Codex",
        account: "team",
        window: "five-hour",
        label: "5-hour",
        remainingPercent: 88,
        resetInMs: 16_800_000,
        fetchedAt: writtenAt,
      },
      {
        provider: "Codex",
        account: "team",
        window: "weekly",
        label: "Weekly",
        remainingPercent: 54,
        resetInMs: 356_400_000,
        fetchedAt: writtenAt,
      },
    ],
    today: totals(4_120_000, 13_260_000, 9),
    week: totals(21_400_000),
    byModel: [
      { provider: "anthropic", model: "Opus", today: totals(3_050_000), week: totals(15_600_000) },
      { provider: "anthropic", model: "Sonnet", today: totals(980_000), week: totals(5_450_000) },
      { provider: "anthropic", model: "Haiku", today: totals(90_000), week: totals(350_000) },
    ],
    byStage: [
      { stage: "research", todayMs: 1_440_000, weekMs: 7_200_000 },
      { stage: "implementation", todayMs: 6_720_000, weekMs: 26_880_000 },
      { stage: "validation", todayMs: 1_080_000, weekMs: 4_320_000 },
      { stage: "review", todayMs: 2_940_000, weekMs: 11_760_000 },
    ],
    malformedEvents: 0,
  };
  return {
    version: 1,
    project,
    writtenAt,
    changeSignature: "after",
    summary: {
      terminal: "tern",
      repoPath: project,
      name: "tandem",
      writtenAt,
      running: 4,
      needsYou: 1,
      ready: 2,
      done: 2,
    },
    panel: {
      header: { title: "tandem", project, projects: [], otherProjectsNeedYou: 0, bellCount: 3 },
      sections: [],
    },
    projects: [],
    tasks: {},
    briefs: {},
    pullRequests: {},
    warnings: [],
    board: {
      viewOnly: true,
      returnLabel: "← Orchestrator",
      lanes: [
        {
          title: "Working",
          count: 2,
          cards: [
            card(
              "tern-backend-adapter",
              "Tern backend adapter",
              "fixing review findings",
              "12m",
              "opus",
              "$1.55",
              283,
            ),
            card(
              "board-snapshot",
              "Board snapshot writer",
              "writing snapshot.ts",
              "6m",
              "sonnet",
              "$0.42",
            ),
          ],
        },
        {
          title: "Needs you",
          count: 1,
          cards: [
            card(
              "tern-backend-brief",
              "Approve brief: Tern backend",
              "approval needed",
              "2m",
              "opus",
              "$0.18",
            ),
          ],
        },
        {
          title: "In review",
          count: 2,
          cards: [
            card(
              "fix-panel-width",
              "Fix panel width",
              "same 2 problems twice",
              "34m",
              "opus",
              "$1.84",
            ),
            card(
              "inbox-alerts",
              "Inbox alerts from task events",
              "reviewer reading",
              "21m",
              "sonnet",
              "$0.88",
            ),
          ],
        },
        {
          title: "Ready to merge",
          count: 2,
          cards: [
            card(
              "terminal-port",
              "Terminal port refactor",
              "waiting on you to publish",
              "52m",
              "opus",
              "$2.31",
              281,
            ),
            card(
              "panel-keys",
              "Panel keyboard navigation",
              "auto-merge armed",
              "41m",
              "sonnet",
              "$0.64",
              278,
            ),
          ],
        },
      ],
    },
    usage: { ...usage, display: usageDisplay(usage, { writtenAt, warnings: [] }) },
    catchup: {
      project,
      merged: [
        {
          number: 276,
          title: "Status line summary",
          state: "merged",
          url: "https://github.com/acme/app/pull/276",
        },
        {
          number: 277,
          title: "Inbox alerts from task events",
          state: "merged",
          url: "https://github.com/acme/app/pull/277",
        },
      ],
      needsYou: [
        {
          key: "brief:req-tern",
          cause: "brief",
          project: "tandem",
          repoPath: project,
          mark: "",
          name: "Approve brief: Tern backend",
          text: "brief waiting for approval",
        },
      ],
      blocked: [
        {
          key: "task:fix-panel-width",
          name: "Fix panel width",
          reason:
            "review found the same 2 problems twice, stopped after 2 automatic restarts. Needs a steer or a restart.",
        },
      ],
      whereWeLeftOff: [
        {
          workstream: "Tern backend",
          text: "Pane naming spike is done and the adapter design is settled. Next: approve the brief, then the adapter and board snapshot writer run in parallel.",
        },
      ],
      workstreams: [],
      actions: ["open-needs-you", "dismiss"],
    },
  };
}
