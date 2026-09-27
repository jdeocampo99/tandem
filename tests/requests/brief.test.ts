import { expect, test } from "bun:test";
import type { RequestBriefContent, RequestBriefRecord, TaskRecord } from "../../src/contracts.ts";
import {
  abandonRequestBriefRecord,
  approveRequestBriefRecord,
  briefSkipsReview,
  checkedRequestBriefContent,
  createRequestBriefRecord,
  decideRequestDispatch,
  openRequestForNewWork,
  RequestBriefError,
  requestApprovalState,
  requestBriefDigests,
  reviseRequestBriefRecord,
  singlePendingApprovalId,
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

test("skipping review is part of what was agreed, and only an approved brief skips it", () => {
  const approve = (record: RequestBriefRecord): RequestBriefRecord =>
    approveRequestBriefRecord(
      record,
      {
        requestId: "req-1",
        briefRevision: record.draft.revision,
        contentDigest: record.draft.contentDigest,
      },
      NOW,
    );
  const approved = approve(seeded());
  const skipping = reviseRequestBriefRecord(approved, content({ skipReview: true }), LATER);

  expect(requestBriefDigests(checkedRequestBriefContent(content({ skipReview: false })))).toEqual(
    requestBriefDigests(content()),
  );
  expect(skipping.draft.changeKind).toBe("agreement");
  expect(briefSkipsReview(approved)).toBe(false);
  expect(briefSkipsReview(skipping)).toBe(false);
  expect(briefSkipsReview(approve(skipping))).toBe(true);
  expect(renderRequestBriefMarkdown(skipping)).toContain("## Code review\nSkipped at your request");
  expect(() => checkedRequestBriefContent({ ...content(), skipReview: "yes" })).toThrow(
    RequestBriefError,
  );
});

const SUMMARY = {
  title: "Keep Premium through the paid period",
  beforeAfter: [
    {
      moment: "Cancelling",
      before: "Premium ends at once.",
      after: "Premium lasts until the period ends.",
    },
    { moment: "When the period ends", before: "Nothing changes.", after: "Premium turns off." },
  ],
  size: { level: "large", reason: "Changes every Premium check." },
  risk: { level: "high", reason: "Touches money and customer access." },
} as const;

test("the brief puts what approval needs above the divider and the details below it", () => {
  const markdown = renderRequestBriefMarkdown(
    createRequestBriefRecord(
      {
        id: "req-1",
        repoPath: "/repo",
        content: content({
          summary: SUMMARY,
          openQuestions: ["Ship to web too?"],
          manualVerification: ["Cancel in the sandbox and keep paid content"],
          recommendedApproach: ["Tell apart why a plan ended", "Use one access rule everywhere"],
        }),
      },
      NOW,
    ),
  );

  expect(markdown.match(/^#+ .+$/gmu)).toEqual([
    "# Keep Premium through the paid period",
    "## TL;DR",
    "## Before and after",
    "## Decisions needed",
    "## Size and risk",
    "## How you'll verify",
    "## Approach",
    "## Details",
    "### In scope",
    "### Out of scope",
    "### Automated checks",
    "### Constraints",
    "### Decisions already made",
    "### References",
    "### Record",
  ]);
  expect(markdown).toContain(
    "1. **Cancelling**\n   - Before: Premium ends at once.\n   - After: Premium lasts until the period ends.\n2. **When the period ends**",
  );
  expect(markdown).toContain(
    "- **Size: Large.** Changes every Premium check.\n- **Risk: High.** Touches money and customer access.",
  );
  expect(markdown).toContain(
    "## Approach\n1. Tell apart why a plan ended\n2. Use one access rule everywhere\n\n---\n",
  );
  expect(markdown).toContain("Revision 1, not approved yet.");
});

test("a brief saved before the summary still renders and keeps its digests", () => {
  const legacy = content();
  const markdown = renderRequestBriefMarkdown(seeded());

  expect(markdown.split("\n")[0]).toBe("# Request brief");
  expect(markdown).not.toContain("## Before and after");
  expect(markdown).not.toContain("## Size and risk");
  expect(markdown).not.toContain("## Decisions needed");
  expect(markdown).toContain("## Approach\nOne record with monotonic draft revisions\n");
  expect(
    requestBriefDigests(checkedRequestBriefContent(JSON.parse(JSON.stringify(legacy)))),
  ).toEqual(requestBriefDigests(legacy));
  expect(requestBriefDigests(content({ summary: SUMMARY })).agreementDigest).not.toBe(
    requestBriefDigests(legacy).agreementDigest,
  );
});

test("a summary must use the fixed labels and one to five moments", () => {
  const withSummary = (summary: unknown) => ({ ...content(), summary });

  expect(checkedRequestBriefContent(withSummary(SUMMARY)).summary).toEqual(SUMMARY);
  expect(() =>
    checkedRequestBriefContent(withSummary({ ...SUMMARY, size: { level: "huge", reason: "x" } })),
  ).toThrow(RequestBriefError);
  expect(() => checkedRequestBriefContent(withSummary({ ...SUMMARY, beforeAfter: [] }))).toThrow(
    RequestBriefError,
  );
  expect(() =>
    checkedRequestBriefContent(
      withSummary({ ...SUMMARY, beforeAfter: Array(6).fill(SUMMARY.beforeAfter[0]) }),
    ),
  ).toThrow(RequestBriefError);
  expect(() => checkedRequestBriefContent({ ...content(), recommendedApproach: [] })).toThrow(
    RequestBriefError,
  );
});

test("new implementation work joins the one open approved request in its repository", () => {
  const approve = (id: string, repoPath = "/repo"): RequestBriefRecord => {
    const record = createRequestBriefRecord({ id, repoPath, content: content() }, NOW);
    return approveRequestBriefRecord(
      record,
      { requestId: id, briefRevision: 1, contentDigest: record.draft.contentDigest },
      NOW,
    );
  };
  const unapproved = createRequestBriefRecord(
    { id: "req-draft", repoPath: "/repo", content: content() },
    NOW,
  );
  const delivered = approve("req-done");
  const settings = approve("req-settings");
  const elsewhere = approve("req-other", "/other-repo");
  const finishedTask = { requestId: "req-done", stage: "completed" as const };

  expect(
    openRequestForNewWork(
      [unapproved, delivered, settings, elsewhere],
      [finishedTask],
      "/repo",
      NOW,
    ),
  ).toBe("req-settings");
  expect(
    openRequestForNewWork([unapproved, delivered], [finishedTask], "/repo", NOW),
  ).toBeUndefined();
  expect(() =>
    openRequestForNewWork([settings, approve("req-onboarding")], [finishedTask], "/repo", NOW),
  ).toThrow(RequestBriefError);
});

test("an approved request with no task after three days no longer counts as open", () => {
  const record = createRequestBriefRecord(
    { id: "req-old", repoPath: "/repo", content: content() },
    NOW,
  );
  const approved = approveRequestBriefRecord(
    record,
    { requestId: "req-old", briefRevision: 1, contentDigest: record.draft.contentDigest },
    NOW,
  );
  const day = 24 * 60 * 60 * 1000;
  const at = (days: number): string => new Date(Date.parse(NOW) + days * day).toISOString();

  expect(openRequestForNewWork([approved], [], "/repo", at(3))).toBe("req-old");
  expect(openRequestForNewWork([approved], [], "/repo", at(3.01))).toBeUndefined();
  const started = [{ requestId: "req-old", stage: "ready" as const }];
  expect(openRequestForNewWork([approved], started, "/repo", at(10))).toBe("req-old");
});

test("an abandoned brief stops awaiting approval and refuses revision, approval, and dispatch", () => {
  const stale = seeded();
  const current = createRequestBriefRecord(
    { id: "req-2", repoPath: "/repo", content: content({ goal: "The brief in view" }) },
    NOW,
  );
  expect(() => singlePendingApprovalId([stale, current])).toThrow(RequestBriefError);

  const abandoned = abandonRequestBriefRecord(stale, [task({ stage: "cancelled" })], LATER);
  expect(abandoned.abandonedAt).toBe(LATER);
  expect(abandoned.revision).toBe(stale.revision + 1);
  expect(singlePendingApprovalId([abandoned, current])).toBe("req-2");
  expect(decideRequestDispatch(abandoned).allowed).toBe(false);
  expect(renderRequestBriefMarkdown(abandoned)).toContain(`abandoned on ${LATER}`);
  const refusals = [
    () => reviseRequestBriefRecord(abandoned, content({ goal: "Changed my mind" }), LATER),
    () =>
      approveRequestBriefRecord(
        abandoned,
        {
          requestId: abandoned.id,
          briefRevision: abandoned.draft.revision,
          contentDigest: abandoned.draft.contentDigest,
        },
        LATER,
      ),
    () => abandonRequestBriefRecord(abandoned, [], LATER),
  ];
  for (const refused of refusals) {
    expect(refused).toThrow(expect.objectContaining({ code: "request-abandoned" }));
  }
});

test("a brief that is approved or still has unfinished work cannot be abandoned", () => {
  const record = seeded();
  expect(() => abandonRequestBriefRecord(record, [task({ stage: "paused" })], LATER)).toThrow(
    expect.objectContaining({ code: "request-in-use" }),
  );
  const approved = approveRequestBriefRecord(
    record,
    { requestId: record.id, briefRevision: 1, contentDigest: record.draft.contentDigest },
    LATER,
  );
  expect(() => abandonRequestBriefRecord(approved, [], LATER)).toThrow(
    expect.objectContaining({ code: "request-in-use" }),
  );
});
