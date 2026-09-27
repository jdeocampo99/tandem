import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Clock,
  IdFactory,
  RequestBriefContent,
  RequestBriefRevision,
  RequestReviewPane,
} from "../../src/contracts.ts";
import {
  approveRequestBriefRecord,
  checkedRequestBriefContent,
  requestApprovalState,
  requestBriefDigests,
  reviseRequestBriefRecord,
  withRequestReviewPane,
} from "../../src/requests/brief.ts";
import {
  readRequestBriefPayload,
  withStateTransaction,
  writeRequestBriefPayload,
} from "../../src/runtime/database.ts";
import { renderRequestBriefMarkdown } from "../../src/requests/markdown.ts";
import { createRequestBriefStore, type RequestBriefStore } from "../../src/requests/store.ts";
import { parseRequestBriefRecord } from "../../src/requests/store-codec.ts";
import { StateCorruptionError, TaskStoreError } from "../../src/tasks/store-errors.ts";

const NOW = "2030-01-01T00:00:00.000Z";

function content(overrides: Partial<RequestBriefContent> = {}): RequestBriefContent {
  return {
    goal: "Durable request identity",
    userStories: [
      {
        actor: "a repository owner",
        action: "record a request",
        outcome: "its agreement survives restart",
      },
    ],
    scope: ["src/requests"],
    constraints: ["fail closed on unreadable state"],
    nonGoals: ["no second ledger"],
    acceptanceCriteria: ["survives restart"],
    verificationCommands: [],
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

function legacyRevision(
  revision: RequestBriefRevision,
  source: RequestBriefContent,
): RequestBriefRevision {
  const {
    userStories: _userStories,
    verificationCommands: _verificationCommands,
    ...legacyContent
  } = source;
  const storedContent = checkedRequestBriefContent(legacyContent, { allowLegacyFields: true });
  return { ...revision, content: storedContent, ...requestBriefDigests(storedContent) };
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

test("a legacy approved brief keeps both digests through review updates", async () => {
  await withHome(async (home, newStore) => {
    const store = newStore();
    const historyContent = content();
    const draftContent = content({ openQuestions: ["which pane?"] });
    const created = await store.create({ repoPath: "/repo", content: historyContent });
    const revised = await store.update(created.id, created.revision, (record) =>
      reviseRequestBriefRecord(record, draftContent, NOW),
    );
    const approved = approveRequestBriefRecord(
      revised,
      {
        requestId: revised.id,
        briefRevision: revised.draft.revision,
        contentDigest: revised.draft.contentDigest,
      },
      NOW,
    );
    const previousRevision = approved.history[0];
    if (previousRevision === undefined) throw new Error("approved brief has no prior revision");
    const legacyDraft = legacyRevision(approved.draft, draftContent);
    const storedLegacy = {
      ...approved,
      history: [legacyRevision(previousRevision, historyContent)],
      draft: legacyDraft,
      approval: {
        requestId: approved.id,
        briefRevision: legacyDraft.revision,
        ...requestBriefDigests(legacyDraft.content),
        approvedAt: NOW,
      },
    };

    await withStateTransaction(home, (db) =>
      writeRequestBriefPayload(db, storedLegacy.id, storedLegacy.revision, storedLegacy),
    );
    const loaded = await store.read(storedLegacy.id);
    if (loaded === undefined) throw new Error("legacy brief could not be read");
    const markdown = renderRequestBriefMarkdown(loaded);

    expect(loaded.draft.content.userStories).toBeUndefined();
    expect(loaded.draft.content.verificationCommands).toBeUndefined();
    expect(loaded.history).toHaveLength(1);
    for (const revision of [...loaded.history, loaded.draft]) {
      expect(Object.hasOwn(revision.content, "userStories")).toBe(false);
      expect(Object.hasOwn(revision.content, "verificationCommands")).toBe(false);
    }
    expect(loaded.draft.contentDigest).toBe(legacyDraft.contentDigest);
    expect(loaded.draft.agreementDigest).toBe(legacyDraft.agreementDigest);
    expect(requestApprovalState(loaded)).toBe("current");
    expect(markdown).not.toContain("## User stories");
    expect(markdown).toContain("## Goal\nDurable request identity");
    expect(markdown).toContain("## Proposed approach\nOne SQLite row per request");
    expect(markdown.indexOf("## Proposed approach")).toBeLessThan(
      markdown.indexOf("## What is included"),
    );
    expect(markdown).toContain("Plan status: approved at revision 2 on");

    const pane: RequestReviewPane = {
      status: "open",
      endpoint: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
        tabId: "tab-1",
        paneId: "pane-1",
        role: "scout",
        generation: 0,
      },
      renderedRevision: loaded.draft.revision,
      renderedPath: "/tmp/request-brief.md",
      observedAt: NOW,
    };
    const projected = await store.update(loaded.id, loaded.revision, (record) =>
      withRequestReviewPane(record, pane, NOW),
    );
    expect(requestApprovalState(projected)).toBe("current");
    expect(projected.draft.contentDigest).toBe(loaded.draft.contentDigest);
    expect(projected.draft.agreementDigest).toBe(loaded.draft.agreementDigest);
    expect(projected.approval).toEqual(loaded.approval);

    const persisted = await withStateTransaction(home, (db) =>
      readRequestBriefPayload(db, loaded.id),
    );
    if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted)) {
      throw new Error("updated legacy payload is missing");
    }
    const persistedRecord = persisted as {
      readonly draft: {
        readonly content: Record<string, unknown>;
        readonly contentDigest: string;
        readonly agreementDigest: string;
      };
      readonly history: readonly { readonly content: Record<string, unknown> }[];
    };
    expect(persistedRecord.draft.contentDigest).toBe(loaded.draft.contentDigest);
    expect(persistedRecord.draft.agreementDigest).toBe(loaded.draft.agreementDigest);
    for (const revision of [...persistedRecord.history, persistedRecord.draft]) {
      expect(Object.hasOwn(revision.content, "userStories")).toBe(false);
      expect(Object.hasOwn(revision.content, "verificationCommands")).toBe(false);
    }
  });
});

test("stored records reject storyless verification-command digest collisions", () => {
  const {
    userStories: _userStories,
    verificationCommands: _verificationCommands,
    ...legacyManualContent
  } = content({ manualVerification: ["bun test"] });
  const legacyContent = checkedRequestBriefContent(legacyManualContent, {
    allowLegacyFields: true,
  });
  const legacyDigests = requestBriefDigests(legacyContent);
  const malformed = content({ userStories: [], verificationCommands: ["bun test"] });
  const { userStories: _partialStories, ...partialMalformed } = malformed;

  for (const storedContent of [partialMalformed, malformed]) {
    expect(() =>
      parseRequestBriefRecord({
        schemaVersion: 1,
        id: "req-1",
        revision: 0,
        repoPath: "/repo",
        createdAt: NOW,
        updatedAt: NOW,
        draft: {
          revision: 1,
          content: storedContent,
          contentDigest: legacyDigests.contentDigest,
          agreementDigest: legacyDigests.agreementDigest,
          changeKind: "agreement",
          recordedAt: NOW,
        },
        history: [],
      }),
    ).toThrow(/both userStories and verificationCommands|one to three user stories/u);
  }
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
