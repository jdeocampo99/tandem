import type { BoardState } from "../../src/board/view.ts";
import type { RequestBriefContent } from "../../src/contracts.ts";
import type { PrWatch } from "../../src/pr-watch/store.ts";

export const NOW = "2030-01-01T12:00:00.000Z";

export function content(goal: string): RequestBriefContent {
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

export function watch(
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

export function state(overrides: Partial<BoardState> = {}): BoardState {
  return {
    projects: ["/work/tandem", "/work/app"],
    tasks: [],
    briefs: [],
    routingPauses: [],
    watches: [],
    poll: {},
    finishedThisWeek: [],
    progressAt: new Map(),
    workerPanes: new Map(),
    ...overrides,
  };
}
