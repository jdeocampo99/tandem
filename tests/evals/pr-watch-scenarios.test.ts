import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { centralConfigPath } from "../../src/config/repositories.ts";
import type { TaskRecord } from "../../src/contracts.ts";
import type { PrWatchViewRow } from "../../src/pr-watch/view.ts";
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

/** Five minutes later, opens the view, which checks GitHub first. */
async function nextCheck(world: ScenarioWorld, service: TandemService): Promise<PrWatchViewRow> {
  world.advanceClock(5);
  return onlyRow(service);
}

async function onlyRow(service: TandemService): Promise<PrWatchViewRow> {
  const view = await service.prWatch();
  const [row] = view.rows;
  if (row === undefined || view.rows.length !== 1) throw new Error("expected one watched PR");
  return row;
}

function emptyCommits(world: ScenarioWorld): number {
  return world.trace().filter((event) => event.action === "gh api PATCH git/refs").length;
}

async function watching(
  body: (world: ScenarioWorld, service: TandemService) => Promise<void>,
): Promise<void> {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    try {
      await body(world, service);
    } finally {
      await service.shutdown();
    }
  });
}

test("a flaky check gets one empty commit, then the PR moves on when it passes", async () => {
  await watching(async (world, service) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [
        { name: "unit", state: "pass" },
        { name: "e2e", state: "fail" },
      ],
    });
    const failingHead = pr.head;
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]).toMatchObject({ color: "green", note: "🔁 retried e2e (flaky?)" });
    expect(emptyCommits(world)).toBe(1);
    expect(pr.head).not.toBe(failingHead);

    pr.checks = [
      { name: "unit", state: "pass" },
      { name: "e2e", state: "pass" },
    ];
    const row = await nextCheck(world, service);
    expect(row).toMatchObject({ color: "green", checks: "✅ 2/2" });
    expect(emptyCommits(world)).toBe(1);
    expect(await service.prWatchNotices()).toEqual([]);
  });
});

test("the same check failing again on the same code goes red and says so once", async () => {
  await watching(async (world, service) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    pr.checks = [{ name: "e2e", state: "fail" }];
    const row = await nextCheck(world, service);
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
    await nextCheck(world, service);
    expect(await service.prWatchNotices()).toEqual([]);
  });
});

test("a check that also fails on main waits for main, then retries", async () => {
  await watching(async (world, service) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "lint", state: "fail" }],
    });
    world.github.setBranchChecks(REPO, "main", [{ name: "lint", state: "fail" }]);
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]).toMatchObject({ color: "yellow", status: "🧱 main is red" });
    expect(emptyCommits(world)).toBe(0);

    world.github.setBranchChecks(REPO, "main", [{ name: "lint", state: "pass" }]);
    const row = await nextCheck(world, service);
    expect(row.note).toBe("🔁 retried lint (flaky?)");
    expect(emptyCommits(world)).toBe(1);
  });
});

test("a push of new code resets the retry budget", async () => {
  await watching(async (world, service) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    pr.checks = [{ name: "e2e", state: "fail" }];
    expect((await nextCheck(world, service)).color).toBe("red");

    world.github.push(pr);
    pr.checks = [{ name: "e2e", state: "fail" }];
    const row = await nextCheck(world, service);
    expect(row).toMatchObject({ color: "green", note: "🔁 retried e2e (flaky?)" });
    expect(emptyCommits(world)).toBe(2);
  });
});

test("an empty commit refused because someone pushed first leaves their push alone", async () => {
  await watching(async (world, service) => {
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
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]?.note).toBe("🔁 someone pushed; checking the new commit");
    const theirs = world.github.push(pr);
    pr.checks = [{ name: "e2e", state: "pending" }];

    const row = await nextCheck(world, service);
    expect(pr.head).toBe(theirs);
    expect(row.color).toBe("green");
    expect(world.trace().filter((event) => event.action === "gh api PATCH git/refs")).toEqual([
      { boundary: "github", action: "gh api PATCH git/refs", outcome: "refused" },
    ]);
  });
});

test("while GitHub is still working out mergeability, the watcher does nothing", async () => {
  await watching(async (world, service) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      mergeable: "UNKNOWN",
      checks: [{ name: "e2e", state: "fail" }],
    });
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]).toMatchObject({
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
  await watching(async (world, service) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "deploy-preview", state: "pending" }],
    });
    expect((await service.prWatchStart({ pullRequest: PR })).rows[0]?.color).toBe("green");
    world.advanceClock(55);
    const row = await nextCheck(world, service);
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
    const watcher = new PrWatcher({
      home: world.home,
      run: world.run,
      clock: world.clock,
      listTasks: () => world.store.list(),
      steerTask: async () => true,
    });
    await watcher.tick();
    const view = await watcher.view();
    expect(view.rows).toMatchObject([{ repo: REPO, number: 7, status: "📝 draft" }]);
    expect(emptyCommits(world)).toBe(0);
  });
});

test("watchAllMyPrs picks up your open pull requests across repositories, except stopped ones", async () => {
  await watching(async (world, service) => {
    await writeFile(join(world.home, "settings.toml"), "watchAllMyPrs = true\n");
    world.github.openPullRequest({ repo: REPO, number: 7 });
    world.github.openPullRequest({ repo: "acme/lib", number: 3 });
    world.github.myPullRequests.push({ repo: REPO, number: 7 }, { repo: "acme/lib", number: 3 });
    await service.prWatchStop({ pullRequest: "https://github.com/acme/lib/pull/3" });

    const view = await service.prWatch();
    expect(view.rows.map((row) => `${row.repo}#${row.number}`)).toEqual([PR]);
  });
});

test("GitHub's rate limit pauses checks and says so in the header", async () => {
  await watching(async (world, service) => {
    world.github.openPullRequest({ repo: REPO, number: 7 });
    world.failAt({ boundary: "github", action: "gh pr view", stderr: "API rate limit exceeded" });
    const limited = await service.prWatchStart({ pullRequest: PR });
    expect(limited.rateLimitedUntil).toBe("2030-01-01T00:15:00.000Z");

    const reads = () => world.trace().filter((event) => event.action === "gh pr view").length;
    await nextCheck(world, service);
    expect(reads()).toBe(1);
    world.advanceClock(10);
    await service.tick();
    expect(reads()).toBe(2);
  });
});

async function watchingWithOrigin(
  body: (world: ScenarioWorld, service: TandemService) => Promise<void>,
): Promise<void> {
  await withScenario({ origin: `https://github.com/${REPO}.git` }, async (world) => {
    const service = serviceFor(world);
    try {
      await body(world, service);
    } finally {
      await service.shutdown();
    }
  });
}

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
  await watching(async (world, service) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      draft: true,
      checks: [{ name: "unit", state: "pass" }],
    });
    const draft = await service.prWatchStart({ pullRequest: PR });
    expect(draft.rows[0]?.status).toBe("📝 draft");
    expect(pr.autoMerge).toBe(false);

    pr.draft = false;
    expect(await nextCheck(world, service)).toMatchObject({
      color: "green",
      status: "🤖 auto-merge",
      note: "🤖 turned on auto-merge",
    });
    expect(pr.autoMerge).toBe(true);
    await nextCheck(world, service);
    expect(world.trace().filter((event) => event.action === "gh pr merge")).toHaveLength(1);
  });
});

test("with an Aviator queue: queued, kicked out by the queue, requeued once, merged", async () => {
  await watching(async (world, service) => {
    world.github.aviatorRepositories.push(REPO);
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "unit", state: "pass" }],
    });
    expect((await service.prWatchStart({ pullRequest: PR })).rows[0]?.status).toBe("🚂 queued");
    expect(pr.labels).toEqual(["mergequeue"]);

    world.github.relabel(pr, {
      add: "blocked",
      remove: "mergequeue",
      by: "aviator-app[bot]",
      bot: true,
    });
    expect(await nextCheck(world, service)).toMatchObject({
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
    expect(await nextCheck(world, service)).toMatchObject({ color: "red", status: "⛔ blocked" });
    expect(labelEdits(world)).toBe(2);
    await service.prWatchNotices();

    world.github.relabel(pr, { add: "mergequeue", remove: "blocked", by: "you", bot: false });
    pr.state = "MERGED";
    pr.mergedAt = world.clock();
    expect((await nextCheck(world, service)).color).toBe("done");
    expect(await service.prWatchNotices()).toEqual([
      { pullRequest: PR, text: "🎉 acme/app#7 merged" },
    ]);
  });
});

test("a person who takes a pull request out of the queue is left alone", async () => {
  await watching(async (world, service) => {
    world.github.aviatorRepositories.push(REPO);
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "unit", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    world.github.relabel(pr, { remove: "mergequeue", by: "sam", bot: false });
    expect(await nextCheck(world, service)).toMatchObject({
      color: "yellow",
      note: "✋ @sam took it out of the queue; leaving it",
    });
    world.github.push(pr);
    await nextCheck(world, service);
    expect(labelEdits(world)).toBe(1);
    expect(pr.labels).toEqual([]);
  });
});

test("a queue label with no blocked label: a flaky kick-out is retried and requeued", async () => {
  await watchingWithOrigin(async (world, service) => {
    await saveMergingSettings(world, 'mergeWith = "queue-label"\nqueueLabel = "ready-to-merge"');
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "pass" }],
    });
    await service.prWatchStart({ pullRequest: "7", repoPath: world.repoPath });
    expect(pr.labels).toEqual(["ready-to-merge"]);

    world.github.relabel(pr, { remove: "ready-to-merge", by: "github-actions[bot]", bot: true });
    pr.checks = [{ name: "e2e", state: "fail" }];
    expect((await nextCheck(world, service)).note).toBe("🔁 retried e2e (flaky?)");

    pr.checks = [{ name: "e2e", state: "pass" }];
    expect((await nextCheck(world, service)).note).toBe("🚂 requeued after the queue took it out");
    expect(pr.labels).toEqual(["ready-to-merge"]);
    expect(world.trace().some((event) => event.action === "gh api GET contents")).toBe(false);
  });
});

test("an approval dismissed by the watcher's empty commit goes red", async () => {
  await watching(async (world, service) => {
    const pr = world.github.openPullRequest({
      repo: REPO,
      number: 7,
      checks: [{ name: "e2e", state: "fail" }],
    });
    await service.prWatchStart({ pullRequest: PR });
    pr.reviewDecision = "REVIEW_REQUIRED";
    pr.checks = [{ name: "e2e", state: "pass" }];
    expect(await nextCheck(world, service)).toMatchObject({
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
  const watcher = new PrWatcher({
    home: world.home,
    run: world.run,
    clock: world.clock,
    listTasks: () => world.store.list(),
    steerTask: async (taskId, text) => {
      steered.push(`${taskId}: ${text}`);
      await setStage("implementing");
      return true;
    },
  });
  const check = async (): Promise<PrWatchViewRow | undefined> => {
    world.advanceClock(5);
    return (await watcher.view()).rows[0];
  };
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
      `${task.id}: Merge origin/main into this branch, resolve the conflicts, commit, and push. Never force-push.`,
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
    const { steered, setStage, watcher, check } = await conflictedTaskPullRequest(world);
    await check();
    await setStage("blocked");
    expect(await check()).toMatchObject({
      color: "red",
      note: "🙋 conflicts in auth/session.ts are still there after a fix",
    });
    expect((await watcher.takeNotices()).map((notice) => notice.askToFix)).toEqual([undefined]);
    expect(steered).toHaveLength(1);
  });
});

test("conflicts that come back on the same base go red instead of another attempt", async () => {
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

test("your own conflicted pull request asks first, and stays red when you decline", async () => {
  await watching(async (world, service) => {
    world.github.openPullRequest({
      repo: REPO,
      number: 7,
      mergeable: "CONFLICTING",
      conflictFiles: ["auth/session.ts"],
    });
    const started = await service.prWatchStart({ pullRequest: PR });
    expect(started.rows[0]).toMatchObject({
      color: "red",
      note: "🙋 fix conflicts in auth/session.ts?",
    });
    expect(await service.prWatchNotices()).toEqual([
      {
        pullRequest: PR,
        text: "acme/app#7 has merge conflicts in auth/session.ts. Fix them?",
        askToFix: true,
      },
    ]);

    expect((await nextCheck(world, service)).color).toBe("red");
    expect(await service.prWatchNotices()).toEqual([]);
    expect((await world.snapshot()).tasks).toEqual([]);
  });
});

test("a yes to fixing your own pull request's conflicts starts an approved task on its branch", async () => {
  await watchingWithOrigin(async (world, service) => {
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

    expect((await nextCheck(world, service)).note).toBe(
      "🔀 resolving conflicts in auth/session.ts",
    );
  });
});
