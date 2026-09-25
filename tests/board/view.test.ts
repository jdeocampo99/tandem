import { expect, test } from "bun:test";
import { type BoardState, boardView, renderBoard } from "../../src/board/view.ts";
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

test("the board puts what needs you first, then running work, then pull requests", () => {
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

  expect(renderBoard(view)).toBe(
    [
      "Tandem · tandem, app · checked 40s ago",
      "",
      "Needs you",
      "🙋 tandem Dark mode                brief waiting for approval",
      "🙋 app    Refactor the cache       asks: Keep the old eviction order?",
      "🙋 app    #409 branch-409          ❌ failing 🙋 test_cache_evict failed twice",
      "",
      "Running",
      "🔨 tandem Fix the flaky login test implementing · 12m",
      "",
      "PRs",
      "🟢 acme/app#420 branch-420 ⏳ 12/16 ✅ approved",
      "",
    ].join("\n"),
  );
  expect(view.needsYou.map((row) => [row.key, row.repoPath])).toEqual([
    ["brief:req-1", "/work/tandem"],
    ["question:q-1", "/work/app"],
    ["pr:acme/app#409", "/work/app"],
  ]);
});

test("an empty board says nothing needs you and that PR watch has not checked yet", () => {
  expect(renderBoard(boardView(state({ projects: [] }), NOW))).toBe(
    "Tandem · PRs not checked yet\n\nNeeds you\nNothing needs you.\n",
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
