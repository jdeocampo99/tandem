import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Lets the watcher's next scheduled check come due, then runs one scheduler tick. */
async function nextCheck(world: ScenarioWorld, service: TandemService): Promise<PrWatchViewRow> {
  world.advanceClock(5);
  await service.tick();
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
      "🔴 acme/app#7 ❌ failing: 🙋 e2e failed twice → https://ci.example/e2e",
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
