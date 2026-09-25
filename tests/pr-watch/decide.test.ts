import { expect, test } from "bun:test";
import {
  decidePrWatch,
  mergingSettings,
  type PrObservation,
  type PrWatchFacts,
  type PrWatchLogEntry,
} from "../../src/pr-watch/decide.ts";
import type { PrWatch } from "../../src/pr-watch/store.ts";
import { pollDue, pollIntervalMinutes } from "../../src/pr-watch/watcher.ts";

const NOW = "2030-01-01T12:00:00.000Z";

function pr(overrides: Partial<PrObservation> = {}): PrObservation {
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
    mergeable: "MERGEABLE",
    behind: false,
    reviewDecision: "APPROVED",
    reviewers: [],
    labels: [],
    autoMerge: false,
    checks: [],
    ...overrides,
  };
}

function facts(overrides: Partial<PrWatchFacts> = {}): PrWatchFacts {
  return {
    observation: pr(),
    log: [],
    settings: mergingSettings(undefined, false),
    now: NOW,
    headSeenAt: NOW,
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
  ).toMatchObject({ row: { color: "red", status: "⚔️ conflict" } });
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
  expect(pollIntervalMinutes([], false, NOW)).toBeUndefined();
  expect(pollIntervalMinutes([], true, NOW)).toBe(5);
  expect(pollIntervalMinutes([watch({ stoppedAt: NOW })], false, NOW)).toBeUndefined();
  expect(pollIntervalMinutes([watch()], false, NOW)).toBe(5);
  expect(pollIntervalMinutes([watch({ summary: running })], false, NOW)).toBe(1);
  expect(pollIntervalMinutes([watch({ log: [retried("tree-1", ["e2e"])] })], false, NOW)).toBe(1);

  const later = "2030-01-01T12:03:00.000Z";
  expect(pollDue({ polledAt: NOW }, [watch()], false, later)).toBe(false);
  expect(pollDue({ polledAt: NOW }, [watch({ summary: running })], false, later)).toBe(true);
  expect(
    pollDue(
      { polledAt: NOW, leaseUntil: "2030-01-01T12:05:00.000Z" },
      [watch({ summary: running })],
      false,
      later,
    ),
  ).toBe(false);
});

test("settings fall back to auto-merge, or Aviator's labels when the repository has its config", () => {
  expect(mergingSettings(undefined, false)).toEqual({
    mergeWith: "auto-merge",
    queueLabel: "mergequeue",
    maxCiRetries: 1,
    stuckAfterMinutes: 60,
  });
  expect(mergingSettings(undefined, true)).toMatchObject({
    mergeWith: "queue-label",
    queueLabel: "mergequeue",
    blockedLabel: "blocked",
  });
  expect(
    mergingSettings({ mergeWith: "queue-label", queueLabel: "ready-to-merge" }, false),
  ).not.toHaveProperty("blockedLabel");
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
