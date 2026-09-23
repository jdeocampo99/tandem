import { expect, test } from "bun:test";
import type { RequestBriefContent, RequestBriefRecord, TaskRecord } from "../../src/contracts.ts";
import {
  approveRequestBriefRecord,
  checkedRequestBriefContent,
  createRequestBriefRecord,
  decideRequestDispatch,
  RequestBriefError,
  requestApprovalState,
  requestBriefDigests,
  reviseRequestBriefRecord,
  tasksAwaitingReapproval,
} from "../../src/requests/brief.ts";
import { renderRequestBriefMarkdown } from "../../src/requests/markdown.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const LATER = "2030-01-01T01:00:00.000Z";

function content(overrides: Partial<RequestBriefContent> = {}): RequestBriefContent {
  return {
    goal: "Give the coordinator a durable request brief",
    scope: ["src/requests"],
    constraints: ["SQLite stays authoritative"],
    nonGoals: ["no desktop GUI"],
    acceptanceCriteria: ["one stable request id"],
    manualVerification: [],
    recommendedApproach: "One record with monotonic draft revisions",
    keyDecisions: ["Markdown is a projection only"],
    openQuestions: [],
    researchLinks: [],
    ...overrides,
  };
}

function seeded(): RequestBriefRecord {
  return createRequestBriefRecord({ id: "req-1", repoPath: "/repo", content: content() }, NOW);
}

type BoundTask = Pick<TaskRecord, "id" | "requestId" | "stage">;

function task(overrides: Partial<BoundTask> = {}): BoundTask {
  return { id: "task-1", requestId: "req-1", stage: "implementing", ...overrides };
}

test("draft revisions advance monotonically and keep every superseded revision in history", () => {
  const first = seeded();
  const second = reviseRequestBriefRecord(
    first,
    content({ openQuestions: ["which pane?"] }),
    LATER,
  );
  const third = reviseRequestBriefRecord(
    second,
    content({ scope: ["src/requests", "src/tasks"] }),
    LATER,
  );

  expect([first.draft.revision, second.draft.revision, third.draft.revision]).toEqual([1, 2, 3]);
  expect(third.history.map((entry) => entry.revision)).toEqual([1, 2]);
  expect(second.draft.changeKind).toBe("annotation");
  expect(third.draft.changeKind).toBe("agreement");
});

test("an annotation keeps approval current while an agreement change supersedes it", () => {
  const approved = approveRequestBriefRecord(
    seeded(),
    { requestId: "req-1", briefRevision: 1, contentDigest: seeded().draft.contentDigest },
    NOW,
  );
  const annotated = reviseRequestBriefRecord(
    approved,
    content({ openQuestions: ["is the pane needed?"], researchLinks: ["https://example.test"] }),
    LATER,
  );
  const rescoped = reviseRequestBriefRecord(annotated, content({ nonGoals: [] }), LATER);

  expect(requestApprovalState(approved)).toBe("current");
  expect(requestApprovalState(annotated)).toBe("current");
  expect(annotated.approval?.briefRevision).toBe(1);
  expect(requestApprovalState(rescoped)).toBe("superseded");
});

test("approval binds to one exact request, revision, and content digest", () => {
  const record = seeded();
  const digest = record.draft.contentDigest;

  expect(() =>
    approveRequestBriefRecord(
      record,
      { requestId: "req-2", briefRevision: 1, contentDigest: digest },
      NOW,
    ),
  ).toThrow(RequestBriefError);
  expect(() =>
    approveRequestBriefRecord(
      record,
      { requestId: "req-1", briefRevision: 2, contentDigest: digest },
      NOW,
    ),
  ).toThrow(/revision/u);
  expect(() =>
    approveRequestBriefRecord(
      record,
      { requestId: "req-1", briefRevision: 1, contentDigest: "0".repeat(64) },
      NOW,
    ),
  ).toThrow(/digest/u);

  const approved = approveRequestBriefRecord(
    record,
    { requestId: "req-1", briefRevision: 1, contentDigest: digest },
    NOW,
  );
  expect(approved.approval).toEqual({
    requestId: "req-1",
    briefRevision: 1,
    contentDigest: digest,
    agreementDigest: record.draft.agreementDigest,
    approvedAt: NOW,
  });
});

test("an approval held for one revision cannot approve the next one", () => {
  const record = seeded();
  const intent = {
    requestId: "req-1",
    briefRevision: record.draft.revision,
    contentDigest: record.draft.contentDigest,
  };
  const advanced = reviseRequestBriefRecord(
    record,
    content({ keyDecisions: ["pane is optional"] }),
    LATER,
  );

  expect(() => approveRequestBriefRecord(advanced, intent, LATER)).toThrow(/revision/u);
});

test("dispatch is refused until the current draft is approved and again once it is superseded", () => {
  const record = seeded();
  expect(decideRequestDispatch(record)).toEqual({
    allowed: false,
    reason: "Request req-1 has no approved brief; its draft is at revision 1",
  });

  const approved = approveRequestBriefRecord(
    record,
    { requestId: "req-1", briefRevision: 1, contentDigest: record.draft.contentDigest },
    NOW,
  );
  expect(decideRequestDispatch(approved)).toEqual({ allowed: true, approvedRevision: 1 });

  const superseded = reviseRequestBriefRecord(approved, content({ constraints: [] }), LATER);
  const decision = decideRequestDispatch(superseded);
  expect(decision.allowed).toBe(false);
  expect(decision.allowed === false ? decision.reason : "").toContain("needs reapproval");
});

test("only running work bound to a superseded brief is named for pausing", () => {
  const record = seeded();
  const approved = approveRequestBriefRecord(
    record,
    { requestId: "req-1", briefRevision: 1, contentDigest: record.draft.contentDigest },
    NOW,
  );
  const tasks = [
    task(),
    task({ id: "task-2", stage: "completed" }),
    task({ id: "task-3", stage: "paused" }),
    task({ id: "task-4", requestId: "req-9" }),
    { id: "task-5", stage: "implementing" } satisfies BoundTask,
  ];

  expect(tasksAwaitingReapproval(approved, tasks)).toEqual([]);
  const superseded = reviseRequestBriefRecord(approved, content({ goal: "something else" }), LATER);
  expect(tasksAwaitingReapproval(superseded, tasks)).toEqual(["task-1"]);
});

test("brief content is validated at the boundary rather than stored as given", () => {
  expect(() => checkedRequestBriefContent({ ...content(), extra: "no" })).toThrow(
    /no field extra/u,
  );
  expect(() => checkedRequestBriefContent(content({ goal: "  " }))).toThrow(/goal/u);
  expect(() => checkedRequestBriefContent(content({ scope: [] }))).toThrow(/at least one scope/u);
  expect(() => checkedRequestBriefContent(content({ acceptanceCriteria: ["ok", ""] }))).toThrow(
    /acceptanceCriteria\[1\]/u,
  );
  expect(() => checkedRequestBriefContent(content({ keyDecisions: ["x".repeat(40_000)] }))).toThrow(
    /UTF-8 bytes/u,
  );
});

test("a brief saved before manual verification existed loads with none and keeps its digests", () => {
  const { manualVerification: _omitted, ...legacy } = content();
  const loaded = checkedRequestBriefContent(legacy);

  expect(loaded.manualVerification).toEqual([]);
  // Digests recorded by the release before manual verification, for this exact content.
  expect(requestBriefDigests(loaded)).toEqual({
    contentDigest: "777275e9c0fa047b1b96b0c7346d31163c8d3b3bba5daec125eb24c838465531",
    agreementDigest: "74a95430904cba395789ce0926801dc88fbf7e9f3332a81faa7f1552a6c9219c",
  });
});

test("moving an item into manual verification changes what was agreed and needs reapproval", () => {
  const approved = approveRequestBriefRecord(
    seeded(),
    { requestId: "req-1", briefRevision: 1, contentDigest: seeded().draft.contentDigest },
    NOW,
  );
  const moved = reviseRequestBriefRecord(
    approved,
    content({ manualVerification: ["the learner sees the lesson in the browser"] }),
    LATER,
  );

  expect(moved.draft.changeKind).toBe("agreement");
  expect(requestApprovalState(moved)).toBe("superseded");
});

test("the brief shows automated checks and manual verification as two lists", () => {
  const record = createRequestBriefRecord(
    {
      id: "req-1",
      repoPath: "/repo",
      content: content({ manualVerification: ["the streak bar glows at 5 in a row"] }),
    },
    NOW,
  );

  const markdown = renderRequestBriefMarkdown(record);

  expect(markdown).toContain("## Automated checks\n- one stable request id\n");
  expect(markdown).toContain("## Manual verification\n- the streak bar glows at 5 in a row\n");
  expect(markdown).not.toContain("Acceptance criteria");
});
