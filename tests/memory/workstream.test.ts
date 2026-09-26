import { expect, test } from "bun:test";
import {
  catchUpView,
  dueFollowUps,
  emptyMemory,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_LINES,
  notesAge,
  parseMemory,
  recentWork,
  renderMemory,
  replaceSections,
  type WorkstreamMemory,
  workstreamLine,
  workstreamName,
} from "../../src/memory/workstream.ts";
import type { PrWatch } from "../../src/pr-watch/store.ts";
import { task } from "../session/fixtures.ts";

// Midday UTC, so the local calendar date is the same in every usual time zone.
const NOW = "2030-01-09T12:00:00.000Z";

function saved(changes: Parameters<typeof replaceSections>[1]): WorkstreamMemory {
  const result = replaceSections(emptyMemory("tia"), changes);
  if (result.kind !== "saved") throw new Error(result.reason);
  return result.memory;
}

function watch(number: number, extra: Partial<PrWatch> = {}): PrWatch {
  return {
    ref: { repo: "acme/app", number },
    origin: "task",
    startedAt: "2030-01-01T00:00:00.000Z",
    log: [],
    ...extra,
  };
}

test("workstream names are lowercase words joined by hyphens", () => {
  expect(workstreamName(" TIA ")).toBe("tia");
  expect(workstreamName("test-impact-2")).toBe("test-impact-2");
  for (const bad of ["", "-tia", "billing/api", "../tia", "a".repeat(41), "two words"]) {
    expect(() => workstreamName(bad)).toThrow(TypeError);
  }
});

test("replacing a section keeps the others and renders them in a fixed order", () => {
  const first = saved({ now: "Rolling out to web.", brief: "Goal: skip safe suites." });
  const result = replaceSections(first, { now: "Mobile pipeline still excluded.", decisions: "" });
  if (result.kind !== "saved") throw new Error(result.reason);
  expect(result.memory.sections).toEqual({
    brief: "Goal: skip safe suites.",
    now: "Mobile pipeline still excluded.",
  });
  expect(result.text).toBe(
    "# tia\n\n## Brief\n\nGoal: skip safe suites.\n\n## Now\n\nMobile pipeline still excluded.\n",
  );
  expect(replaceSections(result.memory, { now: "" })).toMatchObject({
    kind: "saved",
    memory: { sections: { brief: "Goal: skip safe suites." } },
  });
});

test("parsing keeps sections the user added by hand and round-trips the file", () => {
  const text =
    "# tia\n\n## Now\n\nFocus.\n\n## Scratch\n\nmy own notes\n\n## decisions\n\n- 2030-01-01 keep it because fast\n";
  const memory = parseMemory("tia", text);
  expect(memory.sections).toEqual({
    now: "Focus.",
    decisions: "- 2030-01-01 keep it because fast",
  });
  expect(memory.extra).toEqual([{ heading: "Scratch", text: "my own notes" }]);
  expect(parseMemory("tia", renderMemory(memory))).toEqual(memory);
});

test("a save over the line or character cap is refused", () => {
  const lines = Array.from({ length: MEMORY_MAX_LINES }, (_, index) => `- decision ${index}`);
  const tooLong = replaceSections(emptyMemory("tia"), { decisions: lines.join("\n") });
  expect(tooLong.kind).toBe("refused");
  if (tooLong.kind === "refused") expect(tooLong.reason).toContain("Merge or drop old decisions");
  const tooWide = replaceSections(emptyMemory("tia"), { decisions: "x".repeat(MEMORY_MAX_CHARS) });
  expect(tooWide.kind).toBe("refused");
});

test("follow-ups are due on or after their date; lines without one are not follow-ups", () => {
  const memory = saved({
    "follow-ups": [
      "- check missed-failure rate on 2030-01-09 because #412 merged Monday",
      "- check mobile flake count on 2030-01-20 because the fix lands next week",
      "- remember to ask about dashboards",
      "* check the old threshold on 2030-01-02 because it was reverted",
    ].join("\n"),
  });
  expect(dueFollowUps(memory, "2030-01-09").map((followUp) => followUp.due)).toEqual([
    "2030-01-09",
    "2030-01-02",
  ]);
  expect(workstreamLine(memory, NOW)).toBe("tia: 2 follow-ups due");
  expect(workstreamLine(emptyMemory("billing"), NOW)).toBe("billing: nothing due");
});

test("recent work lists the workstream's pull requests newest first, merged by stage, watch, or 🎉 row", () => {
  const pullRequest = (number: number, title: string) => ({
    repository: "Acme/App",
    number,
    title,
    state: "open" as const,
    head: "h",
    base: "main",
  });
  const tasks = [
    task({
      id: "by-stage",
      workstream: "tia",
      stage: "merged",
      updatedAt: "2030-01-05T00:00:00.000Z",
      pullRequest: pullRequest(409, "Metric label fix"),
    }),
    task({
      id: "by-watch",
      workstream: "tia",
      updatedAt: "2030-01-08T00:00:00.000Z",
      pullRequest: pullRequest(412, "Lower skip threshold"),
    }),
    task({
      id: "old-row",
      workstream: "tia",
      updatedAt: "2030-01-07T00:00:00.000Z",
      pullRequest: pullRequest(410, "Old merge"),
    }),
    task({
      id: "open",
      workstream: "tia",
      updatedAt: "2030-01-06T00:00:00.000Z",
      pullRequest: { ...pullRequest(411, "Still open"), state: "draft" },
    }),
    task({ id: "no-pr", workstream: "tia", updatedAt: "2030-01-09T00:00:00.000Z" }),
    task({
      id: "other",
      workstream: "billing",
      updatedAt: "2030-01-09T00:00:00.000Z",
      pullRequest: pullRequest(500, "Billing"),
    }),
  ];
  const watches = [
    watch(412, { taskId: "by-watch", mergedAt: "2030-01-08T00:00:00.000Z" }),
    watch(410, { row: { color: "done", status: "🎉 merged 09:14", note: "" } }),
  ];
  expect(recentWork(tasks, watches, "tia")).toEqual([
    { number: 412, title: "Lower skip threshold", state: "merged" },
    { number: 410, title: "Old merge", state: "merged" },
    { number: 411, title: "Still open", state: "draft" },
    { number: 409, title: "Metric label fix", state: "merged" },
  ]);
  expect(recentWork(tasks, watches, "onboarding")).toEqual([]);
});

test("notes age reads in days", () => {
  expect(notesAge("2030-01-09T08:00:00.000Z", NOW)).toBe("today");
  expect(notesAge("2030-01-08T12:00:00.000Z", NOW)).toBe("yesterday");
  expect(notesAge("2030-01-06T12:00:00.000Z", NOW)).toBe("3 days ago");
});

test("the catch-up view splits what is due from later follow-ups and strips the handoff's date line", () => {
  const memory = saved({
    brief: "Goal: skip safe suites.",
    now: "Lowered flaky-suite skip threshold.",
    "follow-ups": [
      "- check missed-failure rate on 2030-01-09 because #412 merged Monday",
      "- check mobile flakes on 2030-02-01 because the fix lands later",
    ].join("\n"),
    "last-handoff": "Saved 2030-01-06.\nMobile pipeline still excluded.",
  });
  const recent = [{ number: 412, title: "Lower skip threshold", state: "merged" as const }];
  expect(
    catchUpView({
      memory,
      path: "/notes/tia/MEMORY.md",
      savedAt: "2030-01-06T12:00:00.000Z",
      now: NOW,
      recent,
    }),
  ).toEqual({
    name: "tia",
    path: "/notes/tia/MEMORY.md",
    savedOn: "2030-01-06",
    age: "3 days ago",
    today: "2030-01-09",
    due: [
      {
        text: "check missed-failure rate on 2030-01-09 because #412 merged Monday",
        due: "2030-01-09",
      },
    ],
    later: [
      { text: "check mobile flakes on 2030-02-01 because the fix lands later", due: "2030-02-01" },
    ],
    now: "Lowered flaky-suite skip threshold.",
    handoff: { date: "2030-01-06", text: "Mobile pipeline still excluded." },
    brief: "Goal: skip safe suites.",
    extra: [],
    recent,
  });
});
