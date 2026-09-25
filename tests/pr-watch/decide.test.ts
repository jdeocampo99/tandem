import { expect, test } from "bun:test";
import {
  decidePrWatch,
  mergingSettings,
  type PrObservation,
  type PrWatchFacts,
  type PrWatchLogEntry,
  type WatchedCheck,
} from "../../src/pr-watch/decide.ts";
import type { PrWatch } from "../../src/pr-watch/store.ts";
import { pollDue, pollIntervalMinutes } from "../../src/pr-watch/watcher.ts";

const NOW = "2030-01-01T12:00:00.000Z";
const AVIATOR = mergingSettings({
  mergeWith: "queue-label",
  queueLabel: "mergequeue",
  blockedLabel: "blocked",
});

type CheckInput = Omit<WatchedCheck, "required"> & { readonly required?: boolean };

/** An observation; checks are optional unless a test marks them required. */
function pr(
  overrides: Partial<Omit<PrObservation, "checks">> & { checks?: readonly CheckInput[] } = {},
): PrObservation {
  const { checks = [], ...rest } = overrides;
  return {
    state: "open",
    draft: false,
    title: "Add cache",
    url: "https://github.com/acme/app/pull/7",
    branch: "add-cache",
    headRepository: "acme/app",
    fork: false,
    head: "head-1",
    tree: "tree-1",
    base: "main",
    baseHead: "base-1",
    mergeable: "MERGEABLE",
    behind: false,
    reviewDecision: "APPROVED",
    reviewers: [],
    labels: [],
    autoMerge: false,
    ...rest,
    checks: checks.map((check) => ({ required: false, ...check })),
  };
}

function facts(overrides: Partial<PrWatchFacts> = {}): PrWatchFacts {
  return {
    observation: pr(),
    log: [],
    settings: mergingSettings({ mergeWith: "auto-merge" }),
    now: NOW,
    headSeenAt: NOW,
    watchedSince: NOW,
    canSaveMerging: false,
    ...overrides,
  };
}

function retried(tree: string, checks: readonly string[]): PrWatchLogEntry {
  return { at: NOW, kind: "retry", head: "old", tree, checks, pushed: "head-1", approved: true };
}

test("a failed check asks for the base branch's checks before choosing", () => {
  const failing = pr({ checks: [{ name: "e2e", state: "failed" }] });
  expect(decidePrWatch(facts({ observation: failing }))).toEqual({
    kind: "look-up",
    lookup: "base-checks",
  });
  expect(decidePrWatch(facts({ observation: failing, baseFailing: new Set() }))).toMatchObject({
    kind: "decided",
    action: { kind: "retry", checks: ["e2e"] },
  });
});

test("the retry budget is per check and per version of the code", () => {
  const failing = pr({ checks: [{ name: "e2e", state: "failed", url: "https://ci/e2e" }] });
  const spent = facts({
    observation: failing,
    baseFailing: new Set(),
    log: [retried("tree-1", ["e2e"])],
  });
  expect(decidePrWatch(spent)).toEqual({
    kind: "decided",
    row: {
      color: "red",
      status: "❌ failing",
      note: "🙋 e2e failed twice",
      link: "https://ci/e2e",
    },
  });
  expect(decidePrWatch({ ...spent, log: [retried("tree-0", ["e2e"])] })).toMatchObject({
    action: { kind: "retry" },
  });
  expect(decidePrWatch({ ...spent, log: [retried("tree-1", ["unit"])] })).toMatchObject({
    action: { kind: "retry" },
  });
});

test("running checks wait, and one past the limit is stuck", () => {
  const running = pr({
    autoMerge: true,
    checks: [{ name: "build", state: "pending", startedAt: NOW }],
  });
  expect(decidePrWatch(facts({ observation: running }))).toMatchObject({
    row: { color: "green", note: "⏳ CI running" },
  });
  expect(
    decidePrWatch(facts({ observation: running, now: "2030-01-01T13:00:00.000Z" })),
  ).toMatchObject({ row: { color: "red", status: "⏰ stuck" } });
});

test("GitHub's own states come first: merged, still computing, conflicts, changes requested", () => {
  const failing = [{ name: "e2e", state: "failed" as const }];
  expect(
    decidePrWatch(facts({ observation: pr({ state: "merged", mergedAt: NOW }) })),
  ).toMatchObject({
    row: { color: "done" },
  });
  expect(
    decidePrWatch(facts({ observation: pr({ mergeable: "UNKNOWN", checks: failing }) })),
  ).not.toHaveProperty("action");
  expect(
    decidePrWatch(facts({ observation: pr({ mergeable: "CONFLICTING", checks: failing }) })),
  ).toEqual({ kind: "look-up", lookup: "conflict-files" });
  expect(
    decidePrWatch(facts({ observation: pr({ reviewDecision: "CHANGES_REQUESTED" }) })),
  ).toMatchObject({ row: { color: "red" } });
});

test("checks run every minute while busy, every five otherwise, and not at all with nothing watched", () => {
  const watch = (overrides: Partial<PrWatch> = {}): PrWatch => ({
    ref: { repo: "acme/app", number: 7 },
    origin: "user",
    startedAt: NOW,
    log: [],
    ...overrides,
  });
  const running = {
    title: "",
    branch: "",
    url: "",
    checks: { passed: 0, failed: 0, pending: 1 },
  };
  expect(pollIntervalMinutes([], NOW)).toBeUndefined();
  expect(pollIntervalMinutes([watch({ stoppedAt: NOW })], NOW)).toBeUndefined();
  expect(pollIntervalMinutes([watch()], NOW)).toBe(5);
  expect(pollIntervalMinutes([watch({ summary: running })], NOW)).toBe(1);
  expect(pollIntervalMinutes([watch({ log: [retried("tree-1", ["e2e"])] })], NOW)).toBe(1);

  const later = "2030-01-01T12:03:00.000Z";
  expect(pollDue({ polledAt: NOW }, [watch()], later)).toBe(false);
  expect(pollDue({ polledAt: NOW }, [watch({ summary: running })], later)).toBe(true);
  expect(
    pollDue(
      { polledAt: NOW, leaseUntil: "2030-01-01T12:05:00.000Z" },
      [watch({ summary: running })],
      later,
    ),
  ).toBe(false);
});

test("merging stays off until the user chose how the repository merges", () => {
  expect(mergingSettings(undefined)).toEqual({
    mergeWith: "not-set-up",
    queueLabel: "mergequeue",
    maxCiRetries: 1,
    stuckAfterMinutes: 60,
  });
  expect(
    mergingSettings({ mergeWith: "queue-label", queueLabel: "ready-to-merge" }),
  ).not.toHaveProperty("blockedLabel");
  const green = pr({ checks: [{ name: "unit", state: "passed" }] });
  const unset = facts({ observation: green, settings: mergingSettings(undefined) });
  expect(decidePrWatch(unset)).toEqual({
    kind: "decided",
    row: { color: "yellow", status: "✅ approved", note: "merging isn't set up for this repo" },
  });
  expect(decidePrWatch({ ...unset, canSaveMerging: true })).toMatchObject({
    action: { kind: "offer-merging" },
  });
  const offered = { at: NOW, kind: "offer-merging" as const, head: "head-1", tree: "tree-1" };
  expect(decidePrWatch({ ...unset, canSaveMerging: true, log: [offered] })).not.toHaveProperty(
    "action",
  );
  expect(
    decidePrWatch({ ...unset, settings: mergingSettings({ mergeWith: "off" }) }),
  ).toMatchObject({ row: { note: "merging is off for this repo" } });
});

test("a branch GitHub requires to be up to date is updated once per head, never a fork's", () => {
  const behind = facts({
    observation: pr({ behind: true, autoMerge: true, checks: [{ name: "unit", state: "passed" }] }),
    log: [{ at: NOW, kind: "auto-merge", head: "head-0", tree: "tree-0" }],
  });
  expect(decidePrWatch(behind)).toMatchObject({ action: { kind: "update-branch" } });
  expect(
    decidePrWatch({
      ...behind,
      log: [
        ...behind.log,
        {
          at: NOW,
          kind: "update-branch",
          head: "head-1",
          tree: "tree-1",
          checks: [],
          pushed: "head-2",
          approved: true,
        },
      ],
    }),
  ).not.toHaveProperty("action");
  expect(
    decidePrWatch({ ...behind, observation: { ...behind.observation, fork: true } }),
  ).not.toHaveProperty("action");
});

test("conflicts get one fix attempt per pull request: a task is steered, anyone else is asked", () => {
  const conflicting = facts({
    observation: pr({ mergeable: "CONFLICTING" }),
    conflictFiles: ["auth/session.ts"],
  });
  const attempt = (kind: "fix-conflicts" | "ask-conflicts", base: string): PrWatchLogEntry => ({
    at: NOW,
    kind,
    head: "head-1",
    tree: "tree-1",
    base,
    files: ["auth/session.ts"],
  });
  expect(decidePrWatch(conflicting)).toEqual({
    kind: "decided",
    row: { color: "red", status: "⚔️ conflict", note: "🙋 fix conflicts in auth/session.ts?" },
    action: { kind: "ask-conflicts", files: ["auth/session.ts"] },
  });
  const declined = { ...conflicting, log: [attempt("ask-conflicts", "base-0")] };
  const onNewBase = { ...declined.observation, baseHead: "base-9" };
  expect(decidePrWatch({ ...declined, observation: onNewBase })).not.toHaveProperty("action");
  expect(decidePrWatch({ ...declined, watchedSince: "2030-01-01T13:00:00.000Z" })).toMatchObject({
    action: { kind: "ask-conflicts" },
  });

  const tasked = { ...conflicting, task: { working: false } };
  expect(decidePrWatch(tasked)).toMatchObject({ action: { kind: "fix-conflicts" } });
  const fixing = { ...tasked, log: [attempt("fix-conflicts", "base-1")] };
  expect(decidePrWatch({ ...fixing, task: { working: true } })).toMatchObject({
    row: { color: "green", note: "🔀 resolving conflicts in auth/session.ts" },
  });
  expect(decidePrWatch(fixing)).toMatchObject({ row: { color: "red" } });
  // A failed fix stays red while the base moves on; a push and a new base start a new episode.
  const movedBase = { ...fixing.observation, baseHead: "base-9" };
  expect(decidePrWatch({ ...fixing, observation: movedBase })).not.toHaveProperty("action");
  expect(decidePrWatch({ ...fixing, observation: { ...movedBase, head: "head-2" } })).toMatchObject(
    { action: { kind: "fix-conflicts" } },
  );
});

test("the watcher never pushes to a Tandem task's draft, a fork, or ahead of CI starting", () => {
  const failing = pr({ checks: [{ name: "e2e", state: "failed" }] });
  const base = facts({ observation: failing, baseFailing: new Set() });
  expect(decidePrWatch({ ...base, observation: { ...failing, draft: true } })).toMatchObject({
    action: { kind: "retry" },
  });
  expect(
    decidePrWatch({ ...base, observation: { ...failing, draft: true }, task: { working: false } }),
  ).toEqual({
    kind: "decided",
    row: {
      color: "yellow",
      status: "📝 draft",
      note: "⏳ e2e failed; rerunning once it's published",
    },
  });
  expect(decidePrWatch({ ...base, observation: { ...failing, fork: true } })).not.toHaveProperty(
    "action",
  );
  const noChecksYet = facts({
    observation: pr({ labels: ["blocked"] }),
    settings: AVIATOR,
    log: [{ at: NOW, kind: "queue", head: "head-0", tree: "tree-0" }],
  });
  expect(decidePrWatch(noChecksYet)).toMatchObject({ row: { note: "⏳ waiting for CI to start" } });
});

test("a dequeue by a person, or by no one GitHub names, is left alone and never re-armed", () => {
  const queue = AVIATOR;
  const green = pr({ checks: [{ name: "unit", state: "passed" }] });
  const unarmed = facts({ observation: green, settings: queue });
  expect(decidePrWatch(unarmed)).toEqual({ kind: "look-up", lookup: "dequeued-by" });
  expect(
    decidePrWatch({ ...unarmed, dequeuedBy: { login: "sam", bot: false } }),
  ).not.toHaveProperty("action");
  expect(decidePrWatch({ ...unarmed, dequeuedBy: null })).toMatchObject({
    action: { kind: "queue" },
  });
  const kickedOut = facts({
    observation: green,
    settings: queue,
    log: [{ at: NOW, kind: "queue", head: "head-1", tree: "tree-1" }],
    dequeuedBy: null,
  });
  expect(decidePrWatch(kickedOut)).toMatchObject({
    row: { color: "yellow", note: "✋ someone took it out of the queue; leaving it" },
  });
});

test("only required checks drive retries and waiting, unless the repository requires none", () => {
  const optionalFailing = pr({
    autoMerge: true,
    checks: [
      { name: "unit", state: "passed", required: true },
      { name: "preview", state: "failed" },
      { name: "lighthouse", state: "pending", startedAt: "2030-01-01T10:00:00.000Z" },
    ],
  });
  expect(decidePrWatch(facts({ observation: optionalFailing }))).toMatchObject({
    kind: "decided",
    row: { color: "green" },
  });
  expect(decidePrWatch(facts({ observation: optionalFailing }))).not.toHaveProperty("action");
  const noneRequired = pr({ checks: [{ name: "preview", state: "failed" }] });
  expect(decidePrWatch(facts({ observation: noneRequired }))).toEqual({
    kind: "look-up",
    lookup: "base-checks",
  });
});
