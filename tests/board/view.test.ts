import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderStatus, renderStatusLine } from "../../src/board/terminal.ts";
import {
  type BoardState,
  boardView,
  finishedWithinWeek,
  opensBoard,
  renderBoard,
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
    finishedThisWeek: [],
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

  const footer = { code: "9618fa9 Merge (/src/tandem)", coordinators: ["/work/tandem"] };
  expect(renderStatus(view, footer, { color: false })).toBe(
    [
      "Projects: tandem, app · PRs checked 40s ago",
      "",
      `NEEDS YOU 3 ${"─".repeat(62)}`,
      "🙋 tandem  Dark mode                brief waiting for approval",
      "🙋 app     Refactor the cache       question: Keep the old eviction order?",
      "🔴 app     acme/app#409 branch-409  🙋 test_cache_evict failed twice",
      "",
      `RUNNING 2 ${"─".repeat(64)}`,
      "   PROJECT  TASK                      STAGE         TIME",
      "🔨 tandem   Fix the flaky login test  implementing   12m",
      "⏸️ app      Dark mode tokens          paused          2h",
      "",
      `PRS 1 ${"─".repeat(68)}`,
      "   PULL REQUEST             CHECKS          STATUS       NEXT",
      "🟢 acme/app#420 branch-420  ██████░░ 12/16  ✅ approved",
      "",
      "─".repeat(74),
      "1 finished task hidden · coordinators open: tandem",
      "Tandem code: 9618fa9 Merge (/src/tandem)",
      "Ask the coordinator about any task · tandem status --json for task IDs · tandem status --watch for the live view",
      "",
    ].join("\n"),
  );
  expect(renderBoard(view)).toContain("🔨 tandem  Fix the flaky login test  implementing · 12m");
  expect(view.needsYou.map((row) => [row.key, row.repoPath])).toEqual([
    ["brief:req-1", "/work/tandem"],
    ["question:q-1", "/work/app"],
    ["pr:acme/app#409", "/work/app"],
  ]);
});

test("an empty status says nothing needs you, that PR watch has not checked yet, and how to open a coordinator", () => {
  const view = boardView(state({ projects: [] }), NOW);
  expect(renderBoard(view)).toBe(
    "Projects: none yet · PRs not checked yet\n\nNeeds you\nNothing needs you.\n\nLive view: prefix+t in Herdr, or `tandem status --watch`\n",
  );
  const status = renderStatus(view, { code: "abc", coordinators: [] }, { color: false });
  expect(status).toStartWith(
    `Projects: none yet · PRs not checked yet\n\nNEEDS YOU ${"─".repeat(30)}\nNothing needs you.\n`,
  );
  expect(status).toContain("\nno coordinators open, run `tandem`\n");
});

test("on a terminal, status colors sections by meaning and cuts lines to the terminal's width", () => {
  const view = boardView(
    state({
      tasks: [
        task({
          id: "t1",
          repoPath: "/work/tandem",
          stage: "blocked",
          blockReason: "worker exited",
        }),
        task({ id: "t2", repoPath: "/work/tandem", stage: "implementing", objective: "Fix login" }),
      ],
      watches: [watch(420, { color: "yellow", status: "👀 review", note: "" })],
    }),
    NOW,
  );
  const footer = { code: "abc", coordinators: [] };
  const colored = renderStatus(view, footer, { color: true });
  expect(colored).toContain("\x1b[1m\x1b[33mNEEDS YOU\x1b[39m\x1b[22m");
  expect(colored).toContain("\x1b[31m\x1b[1mblocked: \x1b[22m\x1b[39mworker exited");
  expect(colored).toContain("\x1b[36mimplementing\x1b[39m");
  expect(colored).toContain("\x1b[33m██████\x1b[39m\x1b[2m░░\x1b[22m\x1b[33m 12/16\x1b[39m");
  expect(stripVTControlCharacters(colored)).toBe(
    renderStatus(view, footer, { color: false }).replace("Projects: ", " tandem   "),
  );

  const narrow = renderStatus(view, footer, { color: false, columns: 30 });
  for (const line of narrow.trimEnd().split("\n")) {
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
  }
  expect(narrow).toContain(`NEEDS YOU 1 ${"─".repeat(18)}\n`);
  expect(narrow).toContain("🙋 tandem  Implement the requ…");
});

test("an abandoned brief leaves the board", () => {
  const brief = createRequestBriefRecord(
    { id: "req-1", repoPath: "/work/tandem", content: content("Dark mode") },
    NOW,
  );
  const view = boardView(state({ briefs: [{ ...brief, abandonedAt: NOW }] }), NOW);
  expect(view.needsYou).toEqual([]);
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
  expect(view.running.map((row) => [row.key, row.text, row.since])).toEqual([
    ["task:task-paused:paused", "paused", "0s"],
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

test("the weekly line follows the PRs, counting finished tasks, first-pass reviews, and cost", () => {
  const cost = (amountMicros: number) => ({
    currency: "USD" as const,
    amountMicros,
    actualSamples: 1,
    estimatedSamples: 0,
    unavailableSamples: 0,
  });
  const view = boardView(
    state({
      finishedThisWeek: [
        {
          taskId: "a",
          firstPassReview: true,
          fixRounds: 0,
          blockedMs: 0,
          cost: cost(9_000_000),
        },
        {
          taskId: "b",
          firstPassReview: false,
          fixRounds: 1,
          blockedMs: 0,
          cost: cost(5_200_000),
        },
        { taskId: "c", fixRounds: 0, blockedMs: 0 },
      ],
    }),
    NOW,
  );
  expect(renderBoard(view).trimEnd().split("\n").at(-3)).toBe(
    "This week: 3 done · 1 of 2 passed review first time · $14.20",
  );
  expect(renderBoard(boardView(state(), NOW))).not.toContain("This week");
});

test("a task counts for the week when its timeline last finished it within 7 days", () => {
  const finished = (at: string) => [
    {
      type: "stage-changed" as const,
      from: "ready" as const,
      to: "merged" as const,
      taskId: "t",
      at,
    },
  ];
  expect(finishedWithinWeek(finished("2029-12-26T12:00:00.000Z"), NOW)).toBe(true);
  expect(finishedWithinWeek(finished("2029-12-24T11:59:00.000Z"), NOW)).toBe(false);
  expect(finishedWithinWeek([], NOW)).toBe(false);
});

test("the one-line status leads with what needs you, then running work and pull request dots", () => {
  const busy = boardView(
    state({
      briefs: [
        createRequestBriefRecord(
          { id: "req-1", repoPath: "/work/tandem", content: content("Dark mode") },
          NOW,
        ),
      ],
      tasks: [
        task({ id: "t1", stage: "implementing" }),
        task({ id: "t2", stage: "scouting" }),
        task({ id: "t3", stage: "paused" }),
      ],
      watches: [
        watch(409, { color: "red", status: "❌ failing", note: "" }),
        watch(412, { color: "yellow", status: "👀 review", note: "" }),
        watch(420, { color: "green", status: "✅ approved", note: "" }),
        watch(421, { color: "green", status: "✅ approved", note: "" }),
      ],
    }),
    NOW,
  );
  expect(renderStatusLine(busy)).toBe("🙋 2 need you · 🔨 2 running · 🔴 1 🟡 1 🟢 2");

  const one = boardView(state({ tasks: [task({ id: "t1", stage: "ready" })] }), NOW);
  expect(renderStatusLine(one)).toBe("🙋 1 needs you");

  const calm = boardView(state({ tasks: [task({ id: "t1", stage: "implementing" })] }), NOW);
  expect(renderStatusLine(calm)).toBe("✓ nothing needs you · 🔨 1 running");

  const paused = boardView(state({ tasks: [task({ id: "t1", stage: "paused" })] }), NOW);
  expect(renderStatusLine(paused)).toBe("✓ all quiet");
});
