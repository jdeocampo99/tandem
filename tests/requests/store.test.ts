import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, IdFactory, RequestBriefContent } from "../../src/contracts.ts";
import {
  addRequestPlanningQuestion,
  approveRequestBriefRecord,
  recordRequestPlanningAnswer,
  reviseRequestBriefRecord,
} from "../../src/requests/brief.ts";
import { createRequestBriefStore, type RequestBriefStore } from "../../src/requests/store.ts";
import { parseRequestBriefRecord } from "../../src/requests/store-codec.ts";
import { StateCorruptionError, TaskStoreError } from "../../src/tasks/store-errors.ts";

const NOW = "2030-01-01T00:00:00.000Z";

function content(overrides: Partial<RequestBriefContent> = {}): RequestBriefContent {
  return {
    goal: "Durable request identity",
    scope: ["src/requests"],
    constraints: ["fail closed on unreadable state"],
    nonGoals: ["no second ledger"],
    acceptanceCriteria: ["survives restart"],
    manualVerification: [],
    recommendedApproach: "One SQLite row per request",
    keyDecisions: ["compare-and-swap on the record revision"],
    openQuestions: [],
    researchLinks: [],
    ...overrides,
  };
}

async function withHome(
  run: (home: string, newStore: () => RequestBriefStore) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-request-store-")));
  const home = join(root, "home");
  let identifier = 0;
  const clock: Clock = () => NOW;
  const idFactory: IdFactory = () => {
    identifier += 1;
    return `request-${identifier}`;
  };
  try {
    await run(home, () => createRequestBriefStore({ home, clock, idFactory }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a request brief survives a new store over the same authoritative database", async () => {
  await withHome(async (_home, newStore) => {
    const created = await newStore().create({ repoPath: "/repo", content: content() });
    const reread = await newStore().read(created.id);

    expect(created.id).toBe("req-request-1");
    expect(reread).toEqual(created);
    expect(await newStore().list()).toEqual([created]);
  });
});

test("updates advance exactly one record revision under compare-and-swap", async () => {
  await withHome(async (_home, newStore) => {
    const store = newStore();
    const created = await store.create({ repoPath: "/repo", content: content() });
    const revised = await store.update(created.id, created.revision, (record) =>
      reviseRequestBriefRecord(record, content({ openQuestions: ["which pane?"] }), NOW),
    );

    expect(revised.revision).toBe(created.revision + 1);
    expect(revised.draft.revision).toBe(2);
    await expect(
      store.update(created.id, created.revision, (record) =>
        reviseRequestBriefRecord(record, content({ nonGoals: [] }), NOW),
      ),
    ).rejects.toThrow(/does not match expected/u);
  });
});

test("an update that does not advance the record revision exactly once is refused", async () => {
  await withHome(async (_home, newStore) => {
    const store = newStore();
    const created = await store.create({ repoPath: "/repo", content: content() });

    await expect(store.update(created.id, created.revision, (record) => record)).rejects.toThrow(
      TaskStoreError,
    );
    expect((await store.read(created.id))?.revision).toBe(created.revision);
  });
});

test("an approval written to durable state is readable after a restart", async () => {
  await withHome(async (_home, newStore) => {
    const created = await newStore().create({ repoPath: "/repo", content: content() });
    await newStore().update(created.id, created.revision, (record) =>
      approveRequestBriefRecord(
        record,
        {
          requestId: record.id,
          briefRevision: record.draft.revision,
          contentDigest: record.draft.contentDigest,
        },
        NOW,
      ),
    );

    const reread = await newStore().read(created.id);
    expect(reread?.approval?.briefRevision).toBe(1);
    expect(reread?.approval?.contentDigest).toBe(created.draft.contentDigest);
  });
});

test("a stored digest that no longer describes its content fails the read closed", () => {
  const record = {
    schemaVersion: 1,
    id: "req-1",
    revision: 0,
    repoPath: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    draft: {
      revision: 1,
      content: content(),
      contentDigest: "0".repeat(64),
      agreementDigest: "0".repeat(64),
      changeKind: "agreement",
      recordedAt: NOW,
    },
    history: [],
  };

  expect(() => parseRequestBriefRecord(record)).toThrow(StateCorruptionError);
  expect(() => parseRequestBriefRecord(record)).toThrow(/do not describe/u);
});

test("a record whose id is not a request identity fails the read closed", () => {
  expect(() =>
    parseRequestBriefRecord({
      schemaVersion: 1,
      id: "task-1",
      revision: 0,
      repoPath: "/repo",
      createdAt: NOW,
      updatedAt: NOW,
      draft: {
        revision: 1,
        content: content(),
        contentDigest: "unused",
        agreementDigest: "unused",
        changeKind: "agreement",
        recordedAt: NOW,
      },
      history: [],
    }),
  ).toThrow(/unsafe request id/u);
});

test("planning interview state and an explicit answer survive reopening the store", async () => {
  await withHome(async (_home, newStore) => {
    const store = newStore();
    const started = await store.create({
      repoPath: "/repo",
      content: content(),
      planningInterview: {
        schemaVersion: 1,
        status: "active",
        researchTaskIds: ["scout-1"],
        questions: [],
      },
    });
    const asked = await store.update(started.id, started.revision, (record) =>
      addRequestPlanningQuestion(
        record,
        {
          context: "Research found a compatibility tradeoff.",
          question: "Which contract should remain?",
          options: [{ label: "Existing" }, { label: "New" }],
          recommendedOption: 0,
        },
        "plan-1",
        NOW,
      ),
    );
    const question = asked.planningInterview?.questions[0];
    if (question === undefined) throw new Error("planning question was not saved");
    const answered = await store.update(
      asked.id,
      asked.revision,
      (record) =>
        recordRequestPlanningAnswer(record, question.id, { kind: "option", value: "Existing" }, NOW)
          .record,
    );

    expect(await newStore().read(started.id)).toEqual(answered);
  });
});
