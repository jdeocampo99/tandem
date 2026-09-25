import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { centralConfigPath } from "../../src/config/repositories.ts";
import type { TaskRecord } from "../../src/contracts.ts";
import { withPrWatches } from "../../src/pr-watch/store.ts";
import { type PrWatchViewRow, prWatchView } from "../../src/pr-watch/view.ts";
import { PrWatcher } from "../../src/pr-watch/watcher.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { type ScenarioWorld, seedScenarioTask, withScenario } from "./scenario.ts";

const REPO = "acme/app";
const PR = `${REPO}#7`;

function serviceFor(world: ScenarioWorld): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

/**
 * The scheduler's PR watch tick, the only place the watcher acts, with task steering stubbed:
 * a watcher over the same home as the service, awaited so each step's effects are settled.
 */
function watcherFor(
  world: ScenarioWorld,
  steerTask: (taskId: string, text: string) => Promise<boolean> = async () => false,
): PrWatcher {
  return new PrWatcher({
    home: world.home,
    run: world.run,
    clock: world.clock,
    listTasks: () => world.store.list(),
    steerTask,
  });
}

/** Five minutes later the tick runs; returns the one watched row as recorded, without reading. */
async function nextCheck(world: ScenarioWorld, watcher: PrWatcher): Promise<PrWatchViewRow> {
  world.advanceClock(5);
  await watcher.tick();
  const [row, ...others] = await storedRows(world);
  if (row === undefined || others.length > 0) throw new Error("expected one watched PR");
  return row;
}

async function storedRows(world: ScenarioWorld): Promise<readonly PrWatchViewRow[]> {
  const now = world.clock();
  return withPrWatches(
    world.home,
    (transaction) => prWatchView(transaction.watches, transaction.poll, now, []).rows,
  );
}

function emptyCommits(world: ScenarioWorld): number {
  return world.trace().filter((event) => event.action === "gh api PATCH git/refs").length;
}

async function watching(
  body: (world: ScenarioWorld, service: TandemService, watcher: PrWatcher) => Promise<void>,
  options: Readonly<{ origin?: string }> = {},
): Promise<void> {
  await withScenario(options, async (world) => {
    const service = serviceFor(world);
    try {
      await body(world, service, watcherFor(world));
    } finally {
      await service.shutdown();
    }
  });
}

test("a flaky check gets one empty commit, then the PR moves on when it passes", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [
        { name: "unit", state: "pass" },
        { name: "e2e", state: "fail" },
      ],
    });
    const failingHead = pr.head;
    await service.prWatchStart({ pullRequest: PR });
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "green",
      note: "🔁 retried e2e (flaky?)",
    });
    expect(emptyCommits(world)).toBe(1);
    expect(pr.head).not.toBe(failingHead);

    pr.checks = [
      { name: "unit", state: "pass" },
      { name: "e2e", state: "pass" },
    ];
    const row = await nextCheck(world, watcher);
    expect(row).toMatchObject({ color: "green", checks: "✅ 2/2" });
    expect(emptyCommits(world)).toBe(1);
    expect(await service.prWatchNotices()).toEqual([]);
  });
});

test("the same check failing again on the same code goes red and says so once", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    pr.checks = [{ name: "e2e", state: "fail" }];
    const row = await nextCheck(world, watcher);
    expect(row).toMatchObject({
      color: "red",
      status: "❌ failing",
      note: "🙋 e2e failed twice",
      link: "https://ci.example/e2e",
    });
    expect(emptyCommits(world)).toBe(1);
    expect(await service.prWatchNotices()).toEqual([
      {
        pullRequest: PR,
        text: "🔴 acme/app#7 ❌ failing: 🙋 e2e failed twice → https://ci.example/e2e",
      },
    ]);
    await nextCheck(world, watcher);
    expect(await service.prWatchNotices()).toEqual([]);
  });
});

test("a check that also fails on main waits for main, then retries", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "lint", state: "fail" }],
    });
    world.github.setBranchChecks(REPO, "main", [{ name: "lint", state: "fail" }]);
    await service.prWatchStart({ pullRequest: PR });
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "yellow",
      status: "🧱 main is red",
    });
    expect(emptyCommits(world)).toBe(0);

    world.github.setBranchChecks(REPO, "main", [{ name: "lint", state: "pass" }]);
    const row = await nextCheck(world, watcher);
    expect(row.note).toBe("🔁 retried lint (flaky?)");
    expect(emptyCommits(world)).toBe(1);
  });
});

test("a push of new code resets the retry budget", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    pr.checks = [{ name: "e2e", state: "fail" }];
    expect((await nextCheck(world, watcher)).color).toBe("red");

    world.github.push(pr);
    pr.checks = [{ name: "e2e", state: "fail" }];
    const row = await nextCheck(world, watcher);
    expect(row).toMatchObject({ color: "green", note: "🔁 retried e2e (flaky?)" });
    expect(emptyCommits(world)).toBe(2);
  });
});

test("an empty commit refused because someone pushed first leaves their push alone", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    world.failAt({
      boundary: "github",
      action: "gh api PATCH git/refs",
      stderr: "gh: Update is not a fast forward (HTTP 422)",
    });
    await service.prWatchStart({ pullRequest: PR });
    expect((await nextCheck(world, watcher)).note).toBe(
      "🔁 someone pushed; checking the new commit",
    );
    const theirs = world.github.push(pr);
    pr.checks = [{ name: "e2e", state: "pending" }];

    const row = await nextCheck(world, watcher);
    expect(pr.head).toBe(theirs);
    expect(row.color).toBe("green");
    expect(world.trace().filter((event) => event.action === "gh api PATCH git/refs")).toEqual([
      { boundary: "github", action: "gh api PATCH git/refs", outcome: "refused" },
    ]);
  });
});

test("while GitHub is still working out mergeability, the watcher does nothing", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      mergeable: "UNKNOWN",
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "green",
      note: "⏳ GitHub is still checking for conflicts",
    });
    expect(emptyCommits(world)).toBe(0);
  });
});

test("a PR GitHub will not show reads as can't read, never as no checks", async () => {
  await watching(async (world, service) => {
    world.github.openPullRequest({ repo: REPO, number: 7 });
    world.failAt({
      boundary: "github",
      action: "gh pr view",
      stderr: "GraphQL: Resource protected by organization SAML enforcement.",
    });
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]).toMatchObject({
      color: "red",
      checks: "⚠",
      status: "⚠ can't read",
      note: "GraphQL: Resource protected by organization SAML enforcement.",
    });
  });
});

test("a check pending longer than the limit goes red as stuck", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "deploy-preview", state: "pending" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    expect((await nextCheck(world, watcher)).color).toBe("green");
    world.advanceClock(50);
    const row = await nextCheck(world, watcher);
    expect(row).toMatchObject({
      color: "red",
      status: "⏰ stuck",
      note: "🙋 deploy-preview has not finished in 60 min",
    });
  });
});

test("a Tandem task's pull request is watched without anyone asking", async () => {
  await withScenario({}, async (world) => {
    const pr = world.github.openPullRequest({ repo: REPO, number: 7, draft: true });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      pullRequest: { repository: REPO, number: 7, state: "draft", head: pr.head, base: "main" },
    });
    const watcher = watcherFor(world);
    await watcher.tick();
    expect(await storedRows(world)).toMatchObject([{ repo: REPO, number: 7, status: "📝 draft" }]);
    expect(emptyCommits(world)).toBe(0);
  });
});

test("your other open pull requests are shown, and never acted on, until you hand one over", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({
      repo: "acme/lib",
      number: 3,
      title: "Bump the parser",
      checks: [{ name: "e2e", state: "fail" }],
    });
    world.github.myPullRequests.push({ repo: "acme/lib", number: 3 });
    const view = await service.prWatch();
    expect(view.rows).toEqual([
      {
        repo: "acme/lib",
        number: 3,
        branch: "Bump the parser",
        url: "https://github.com/acme/lib/pull/3",
        color: "unwatched",
        checks: "",
        status: "🟢 open",
        note: 'not watched; "watch #3" hands it over',
      },
    ]);
    await nextCheck(world, watcher).catch(() => undefined);
    expect(world.trace().filter((event) => event.action.startsWith("gh api"))).toEqual([]);
    expect(world.trace().some((event) => event.action === "gh pr edit")).toBe(false);

    await service.prWatchStart({ pullRequest: "acme/lib#3" });
    await nextCheck(world, watcher);
    expect(emptyCommits(world)).toBe(1);
  });
});

test("opening the view reads GitHub but never acts", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]?.note).toBe("🔁 retrying e2e");
    world.advanceClock(5);
    await service.prWatch();
    expect(emptyCommits(world)).toBe(0);
    await nextCheck(world, watcher);
    expect(emptyCommits(world)).toBe(1);
  });
});

test("only required checks drive retries; an optional failure never blocks merging", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [
        { name: "unit", state: "pass", required: true },
        { name: "preview", state: "fail" },
      ],
    });
    await service.prWatchStart({ pullRequest: PR });
    expect(await nextCheck(world, watcher)).toMatchObject({
      checks: "❌ 1/2",
      status: "🤖 auto-merge",
    });
    expect(emptyCommits(world)).toBe(0);
    expect(pr.autoMerge).toBe(true);
  });
});

test("GitHub's rate limit pauses checks and says so in the header", async () => {
  await watching(async (world, service, watcher) => {
    world.github.openPullRequest({ repo: REPO, number: 7 });
    world.failAt({ boundary: "github", action: "gh pr view", stderr: "API rate limit exceeded" });
    const limited = await service.prWatchStart({ pullRequest: PR });
    expect(limited.rateLimitedUntil).toBe("2030-01-01T00:15:00.000Z");

    const reads = () => world.trace().filter((event) => event.action === "gh pr view").length;
    world.advanceClock(5);
    await watcher.tick();
    expect(reads()).toBe(1);
    world.advanceClock(10);
    await watcher.tick();
    expect(reads()).toBe(2);
  });
});

const ORIGIN = { origin: `https://github.com/${REPO}.git` };

/** Saves the project's settings.toml with a `[merging]` section. */
async function saveMergingSettings(world: ScenarioWorld, merging: string): Promise<void> {
  const path = await centralConfigPath(world.repoPath, world.home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `repoPath = ${JSON.stringify(world.repoPath)}\n\n[merging]\n${merging}\n`);
}

function labelEdits(world: ScenarioWorld): number {
  return world.trace().filter((event) => event.action === "gh pr edit").length;
}

test("a published pull request gets auto-merge once, and a draft never does", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      draft: true,
      checks: [{ name: "unit", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    expect((await nextCheck(world, watcher)).status).toBe("📝 draft");
    expect(pr.autoMerge).toBe(false);

    pr.draft = false;
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "green",
      status: "🤖 auto-merge",
      note: "🤖 turned on auto-merge",
    });
    expect(pr.autoMerge).toBe(true);
    await nextCheck(world, watcher);
    expect(world.trace().filter((event) => event.action === "gh pr merge")).toHaveLength(1);
  });
});

test("with an Aviator queue: queued, kicked out by the queue, requeued once, merged", async () => {
  await watching(async (world, service, watcher) => {
    world.github.aviatorRepositories.push(REPO);
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "unit", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    expect((await nextCheck(world, watcher)).status).toBe("🚂 queued");
    expect(pr.labels).toEqual(["mergequeue"]);

    world.github.relabel(pr, {
      add: "blocked",
      remove: "mergequeue",
      by: "aviator-app[bot]",
      bot: true,
    });
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "green",
      note: "🚂 requeued after the queue took it out",
    });
    expect(pr.labels).toEqual(["mergequeue"]);

    world.github.relabel(pr, {
      add: "blocked",
      remove: "mergequeue",
      by: "aviator-app[bot]",
      bot: true,
    });
    expect(await nextCheck(world, watcher)).toMatchObject({ color: "red", status: "⛔ blocked" });
    expect(labelEdits(world)).toBe(2);
    await service.prWatchNotices();

    world.github.relabel(pr, { add: "mergequeue", remove: "blocked", by: "you", bot: false });
    pr.state = "MERGED";
    pr.mergedAt = world.clock();
    expect((await nextCheck(world, watcher)).color).toBe("done");
    expect(await service.prWatchNotices()).toEqual([
      { pullRequest: PR, text: "🎉 acme/app#7 merged" },
    ]);
  });
});

test("a person who takes a pull request out of the queue is left alone", async () => {
  await watching(async (world, service, watcher) => {
    world.github.aviatorRepositories.push(REPO);
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "unit", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    world.github.relabel(pr, { remove: "mergequeue", by: "sam", bot: false });
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "yellow",
      note: "✋ @sam took it out of the queue; leaving it",
    });
    world.github.push(pr);
    await nextCheck(world, watcher);
    expect(labelEdits(world)).toBe(1);
    expect(pr.labels).toEqual([]);
  });
});

test("a queue label with no blocked label: a flaky kick-out is retried and requeued", async () => {
  await watching(async (world, service, watcher) => {
    await saveMergingSettings(world, 'mergeWith = "queue-label"\nqueueLabel = "ready-to-merge"');
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: "7", repoPath: world.repoPath });
    await nextCheck(world, watcher);
    expect(pr.labels).toEqual(["ready-to-merge"]);

    world.github.relabel(pr, { remove: "ready-to-merge", by: "github-actions[bot]", bot: true });
    pr.checks = [{ name: "e2e", state: "fail" }];
    expect((await nextCheck(world, watcher)).note).toBe("🔁 retried e2e (flaky?)");

    pr.checks = [{ name: "e2e", state: "pass" }];
    expect((await nextCheck(world, watcher)).note).toBe("🚂 requeued after the queue took it out");
    expect(pr.labels).toEqual(["ready-to-merge"]);
    expect(world.trace().some((event) => event.action === "gh api GET contents")).toBe(false);
  }, ORIGIN);
});

test("an approval dismissed by the watcher's empty commit goes red", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    pr.reviewDecision = "REVIEW_REQUIRED";
    pr.checks = [{ name: "e2e", state: "pass" }];
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "red",
      status: "✋ approval",
      note: "🙋 the watcher's push dismissed the approval",
    });
  });
});

/**
 * A Tandem task's open pull request with merge conflicts, and a watcher whose steering moves the
 * task back to implementing the way a real steer does, recording what it was told.
 */
async function conflictedTaskPullRequest(world: ScenarioWorld) {
  const pr = world.github.openPullRequest({
    repo: REPO,
    number: 7,
    autoMerge: true,
    mergeable: "CONFLICTING",
    conflictFiles: ["auth/session.ts"],
    checks: [{ name: "unit", state: "pass" }],
  });
  const task = await seedScenarioTask(world, {
    kind: "implementation",
    stage: "ready",
    pullRequest: { repository: REPO, number: 7, state: "open", head: pr.head, base: "main" },
  });
  const steered: string[] = [];
  const setStage = async (stage: TaskRecord["stage"]) => {
    const current = await world.store.read(task.id);
    if (current === undefined) throw new Error("the seeded task is gone");
    await world.store.update(task.id, current.revision, (record) => ({
      ...record,
      revision: record.revision + 1,
      stage,
    }));
  };
  const watcher = watcherFor(world, async (taskId, text) => {
    steered.push(`${taskId}: ${text}`);
    await setStage("implementing");
    return true;
  });
  const check = (): Promise<PrWatchViewRow> => nextCheck(world, watcher);
  return { pr, task, steered, setStage, watcher, check };
}

test("a Tandem task resolves its pull request's conflicts, then it merges", async () => {
  await withScenario({}, async (world) => {
    const { pr, task, steered, setStage, watcher, check } = await conflictedTaskPullRequest(world);
    expect(await check()).toMatchObject({
      color: "green",
      status: "🔀 conflict",
      note: "🔀 resolving conflicts in auth/session.ts",
    });
    expect(steered).toEqual([
      `${task.id}: Pull this branch from origin, merge origin/main into it, resolve the conflicts, commit, and push. Never force-push.`,
    ]);

    world.github.push(pr);
    pr.mergeable = "MERGEABLE";
    pr.checks = [{ name: "unit", state: "pending" }];
    await setStage("ready");
    expect((await check())?.note).toBe("🔀 resolved conflicts in auth/session.ts · CI running");

    pr.checks = [{ name: "unit", state: "pass" }];
    pr.state = "MERGED";
    expect((await check())?.color).toBe("done");
    expect(await watcher.takeNotices()).toEqual([
      { pullRequest: PR, text: "🎉 acme/app#7 merged" },
    ]);
    expect(steered).toHaveLength(1);
  });
});

test("conflicts the task could not resolve go red", async () => {
  await withScenario({}, async (world) => {
    const { pr, steered, setStage, watcher, check } = await conflictedTaskPullRequest(world);
    await check();
    await setStage("blocked");
    expect(await check()).toMatchObject({
      color: "red",
      note: "🙋 conflicts in auth/session.ts are still there after a fix",
    });
    expect((await watcher.takeNotices()).map((notice) => notice.askToFix)).toEqual([undefined]);
    pr.baseHead = "base-2";
    expect((await check()).color).toBe("red");
    expect(steered).toHaveLength(1);
  });
});

test("conflicts that come back on the same base go red; after a push, a new base gets a new attempt", async () => {
  await withScenario({}, async (world) => {
    const { pr, steered, setStage, check } = await conflictedTaskPullRequest(world);
    await check();
    world.github.push(pr);
    pr.mergeable = "MERGEABLE";
    await setStage("ready");
    expect((await check())?.color).toBe("green");

    world.github.push(pr);
    pr.mergeable = "CONFLICTING";
    expect((await check())?.color).toBe("red");
    expect(steered).toHaveLength(1);

    pr.baseHead = "base-2";
    expect((await check())?.color).toBe("green");
    expect(steered).toHaveLength(2);
  });
});

test("your own conflicted pull request asks once, and stays red when you decline until you watch it again", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      mergeable: "CONFLICTING",
      conflictFiles: ["auth/session.ts"],
    });
    await service.prWatchStart({ pullRequest: PR });
    await service.prWatchNotices();
    expect(await nextCheck(world, watcher)).toMatchObject({
      color: "red",
      note: "🙋 fix conflicts in auth/session.ts?",
    });
    const question = [
      {
        pullRequest: PR,
        text: "acme/app#7 has merge conflicts in auth/session.ts. Fix them?",
        askToFix: true,
      },
    ];
    expect(await service.prWatchNotices()).toEqual(question);

    pr.baseHead = "base-2";
    expect((await nextCheck(world, watcher)).color).toBe("red");
    expect(await service.prWatchNotices()).toEqual([]);
    expect((await world.snapshot()).tasks).toEqual([]);

    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    expect(await service.prWatchNotices()).toEqual(question);
  });
});

test("a yes to fixing your own pull request's conflicts starts an approved task on its branch", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      branch: "refactor-cache",
      mergeable: "CONFLICTING",
      conflictFiles: ["auth/session.ts"],
    });
    await service.prWatchStart({ pullRequest: "7", repoPath: world.repoPath });
    const task = await service.prWatchFix({ pullRequest: "7", repoPath: world.repoPath });
    expect(task.stage).toBe("queued");
    expect(task.pullRequest).toMatchObject({
      repository: REPO,
      number: 7,
      state: "open",
      head: pr.head,
    });
    expect(task.objective).toContain("git push origin HEAD:refactor-cache. Never force-push.");

    expect((await nextCheck(world, watcher)).note).toBe(
      "🔀 resolving conflicts in auth/session.ts",
    );
  }, ORIGIN);
});

test("a red row is told once, even when GitHub recomputing mergeability shows it green between", async () => {
  await watching(async (world, service, watcher) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      reviewDecision: "CHANGES_REQUESTED",
    });
    await service.prWatchStart({ pullRequest: PR });
    await nextCheck(world, watcher);
    expect(await service.prWatchNotices()).toHaveLength(1);
    pr.mergeable = "UNKNOWN";
    expect((await nextCheck(world, watcher)).color).toBe("green");
    pr.mergeable = "MERGEABLE";
    expect((await nextCheck(world, watcher)).color).toBe("red");
    expect(await service.prWatchNotices()).toEqual([]);
  });
});
