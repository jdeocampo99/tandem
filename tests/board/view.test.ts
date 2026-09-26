import { expect, test } from "bun:test";
import {
  type BoardState,
  boardView,
  opensBoard,
  renderBoard,
  renderStatus,
} from "../../src/board/view.ts";
import type { RequestBriefContent } from "../../src/contracts.ts";
import type { PrWatch } from "../../src/pr-watch/store.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { task } from "../session/fixtures.ts";

const NOW = "2030-01-01T12:00:00.000Z";

function content(goal: string): RequestBriefContent {
  return {
    goal,
    scope: ["the settings page"],
    constraints: [],
    nonGoals: [],
    acceptanceCriteria: ["dark mode follows the system setting"],
    manualVerification: [],
    recommendedApproach: "CSS variables",
    keyDecisions: [],
    openQuestions: [],
    researchLinks: [],
  };
}

function watch(
  number: number,
  row: NonNullable<PrWatch["row"]>,
  extra: Partial<PrWatch> = {},
): PrWatch {
  return {
    ref: { repo: "acme/app", number },
    origin: "user",
    startedAt: "2030-01-01T00:00:00.000Z",
    log: [],
    row,
    summary: {
      title: "t",
      branch: `branch-${number}`,
      url: `https://github.com/acme/app/pull/${number}`,
      checks: { passed: 12, failed: 0, pending: 4 },
    },
    ...extra,
  };
}

function state(overrides: Partial<BoardState> = {}): BoardState {
  return {
    projects: ["/work/tandem", "/work/app"],
    tasks: [],
    briefs: [],
    watches: [],
    poll: {},
    ...overrides,
  };
}

test("status puts what needs you first, then running work and pull requests, then the footer", () => {
  const view = boardView(
    state({
      briefs: [
        createRequestBriefRecord(
          { id: "req-1", repoPath: "/work/tandem", content: content("Dark mode") },
          NOW,
        ),
      ],
      tasks: [
        task({
          id: "task-q",
          repoPath: "/work/app",
          stage: "implementing",
          objective: "Refactor the cache",
          communication: {
            revision: 1,
            messages: [],
            question: { id: "q-1", text: "Keep the old eviction order?" },
          },
        }),
        task({
          id: "task-run",
          repoPath: "/work/tandem",
          stage: "implementing",
          objective: "Fix the flaky login test",
          createdAt: "2030-01-01T11:48:00.000Z",
        }),
        task({
          id: "task-paused",
          repoPath: "/work/app",
          stage: "paused",
          objective: "Dark mode tokens",
          createdAt: "2030-01-01T10:00:00.000Z",
        }),
        task({ id: "task-done", stage: "merged", objective: "Already merged" }),
      ],
      watches: [
        watch(420, { color: "green", status: "✅ approved", note: "" }),
        watch(
          409,
          { color: "red", status: "❌ failing", note: "🙋 test_cache_evict failed twice" },
          { repoPath: "/work/app" },
        ),
      ],
      poll: { readAt: "2030-01-01T11:59:20.000Z" },
    }),
    NOW,
  );

  expect(
    renderStatus(view, { code: "9618fa9 Merge (/src/tandem)", coordinators: ["/work/tandem"] }),
  ).toBe(
    [
      "Projects: tandem, app · PRs checked 40s ago",
      "",
      "Needs you",
      "🙋 tandem  Dark mode                brief waiting for approval",
      "🙋 app     Refactor the cache       question: Keep the old eviction order?",
      "🔴 app     acme/app#409 branch-409  🙋 test_cache_evict failed twice",
      "",
      "Running",
      "🔨 tandem  Fix the flaky login test  implementing · 12m",
      "⏸️ app     Dark mode tokens          paused · 2h",
      "",
      "PRs",
      "🟢 acme/app#420 branch-420 ⏳ 12/16 ✅ approved",
      "",
      "1 finished task hidden · coordinators open: tandem",
      "Tandem code: 9618fa9 Merge (/src/tandem)",
      "Ask the coordinator about any task, or run `tandem status --json` for task IDs · live view: tandem status --watch",
      "",
    ].join("\n"),
  );
  expect(view.needsYou.map((row) => [row.key, row.repoPath])).toEqual([
    ["brief:req-1", "/work/tandem"],
    ["question:q-1", "/work/app"],
    ["pr:acme/app#409", "/work/app"],
  ]);
});

test("an empty status says nothing needs you, that PR watch has not checked yet, and how to open a coordinator", () => {
  const view = boardView(state({ projects: [] }), NOW);
  expect(renderBoard(view)).toBe(
    "Projects: none yet · PRs not checked yet\n\nNeeds you\nNothing needs you.\n",
  );
  expect(renderStatus(view, { code: "abc", coordinators: [] })).toContain(
    "\nno coordinators open, run `tandem`\n",
  );
});

test("an approved brief leaves the board, and a blocked task says why", () => {
  const brief = createRequestBriefRecord(
    { id: "req-1", repoPath: "/work/tandem", content: content("Dark mode") },
    NOW,
  );
  const view = boardView(
    state({
      briefs: [
        {
          ...brief,
          approval: {
            requestId: brief.id,
            briefRevision: brief.draft.revision,
            contentDigest: brief.draft.contentDigest,
            agreementDigest: brief.draft.agreementDigest,
            approvedAt: NOW,
          },
        },
      ],
      tasks: [task({ stage: "blocked", blockReason: "validation failed twice" })],
    }),
    NOW,
  );
  expect(view.needsYou.map((row) => row.text)).toEqual(["blocked: validation failed twice"]);
});

test("a paused task shows under Running, and a blocked task is the only row that does not open the board", () => {
  const view = boardView(
    state({
      briefs: [
        createRequestBriefRecord(
          { id: "req-1", repoPath: "/work/tandem", content: content("Dark mode") },
          NOW,
        ),
      ],
      tasks: [
        task({ id: "task-paused", stage: "paused", objective: "Paused work", createdAt: NOW }),
        task({ id: "task-blocked", stage: "blocked", blockReason: "worker exited" }),
        task({ id: "task-approval", stage: "awaiting-approval" }),
        task({ id: "task-ready", stage: "ready" }),
        task({
          id: "task-q",
          stage: "implementing",
          communication: { revision: 1, messages: [], question: { id: "q-1", text: "Which?" } },
        }),
      ],
      watches: [watch(409, { color: "red", status: "❌ failing", note: "" })],
    }),
    NOW,
  );
  expect(view.running.map((row) => [row.key, row.text])).toEqual([
    ["task:task-paused:paused", "paused · 0s"],
  ]);
  expect(view.needsYou.map((row) => [row.key, opensBoard(row)])).toEqual([
    ["brief:req-1", true],
    ["task:task-blocked:blocked", false],
    ["task:task-approval:awaiting-approval", true],
    ["task:task-ready:ready", true],
    ["question:q-1", true],
    ["pr:acme/app#409", true],
  ]);
});
