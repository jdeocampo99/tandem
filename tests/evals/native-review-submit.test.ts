import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunner } from "../../src/contracts.ts";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import { reviewMarker } from "../../src/pr-review/post.ts";
import {
  type PrReviewRound,
  type PrReviewState,
  prReviewRunDiffPath,
} from "../../src/pr-review/state.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { executeTandemAction, type TandemAction } from "../../src/session/actions.ts";
import { tandemRequestSchema } from "../../src/session/tools.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  withScenario,
} from "./scenario.ts";

async function seedReview(world: ScenarioWorld) {
  const round: PrReviewRound = {
    generation: 0,
    head: SCENARIO_HEAD,
    from: SCENARIO_HEAD,
    notes: [],
    review: {
      head: SCENARIO_HEAD,
      intent: "Check the change",
      tour: [],
      concerns: [],
      comments: [],
      summaryComment: "Looks good",
      priorComments: [],
    },
  };
  const state: PrReviewState = {
    ref: { repo: "owner/repo", number: 7 },
    url: "https://github.com/owner/repo/pull/7",
    title: "A change",
    author: "author",
    baseRef: "main",
    checkout: world.repoPath,
    remote: "origin",
    lens: { kind: "full" },
    mode: "review",
    rounds: [round],
  };
  const initial = await world.store.create({
    id: SCENARIO_TASK_ID,
    repoPath: world.repoPath,
    kind: "pr-review",
    objective: "Review the displayed round",
    acceptanceCriteria: [],
    surfaces: [],
    policy: SCENARIO_POLICY,
    prReview: state,
  });
  await world.store.update(initial.id, initial.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    stage: "completed",
  }));
  const diff = prReviewRunDiffPath(world.home, SCENARIO_TASK_ID, 0);
  await mkdir(dirname(diff), { recursive: true });
  await writeFile(diff, "");
  return { round, state };
}

function reviewService(world: ScenarioWorld, run: CommandRunner) {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    clock: world.clock,
    idFactory: world.idFactory,
    run,
  });
}

test("store mutations proceed during a native POST and its receipt settles only the posted round", async () => {
  await withScenario({}, async (world) => {
    const { round, state } = await seedReview(world);
    const posting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const payloads: unknown[] = [];
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      clock: world.clock,
      idFactory: world.idFactory,
      run: async (request) => {
        if (request.argv[0] !== "gh") return world.run(request);
        if (request.argv.includes("--slurp")) return { code: 0, stdout: "[[]]", stderr: "" };
        if (request.argv.includes("headRefOid"))
          return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
        if (request.argv.includes("POST")) {
          payloads.push(JSON.parse(request.stdin ?? "{}"));
          posting.resolve();
          await release.promise;
          return {
            code: 0,
            stdout: JSON.stringify({ html_url: `${state.url}#review-1` }),
            stderr: "",
          };
        }
        throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
      },
    });
    const submission: ReviewSubmission = {
      tandemPrReview: 1,
      verdict: "approve",
      summary: "Approved from the displayed round",
      drafts: [],
      yours: [],
    };
    const expected = { head: SCENARIO_HEAD, generation: 0 };
    let replacement: Promise<unknown> | undefined;
    const submitted = service.reviewSubmit(SCENARIO_TASK_ID, submission, expected);
    try {
      await posting.promise;
      replacement = world.store.exclusive(async (store) => {
        const current = await store.read(SCENARIO_TASK_ID);
        if (current?.prReview === undefined) throw new Error("Missing scenario review");
        const currentReview = current.prReview;
        await store.update(current.id, current.revision, (task) => ({
          ...task,
          objective: "Changed while the POST is in flight",
          generation: 1,
          revision: task.revision + 1,
          prReview: {
            ...currentReview,
            rounds: [
              ...currentReview.rounds,
              {
                ...round,
                head: SCENARIO_NEXT_HEAD,
                generation: 1,
                review: { ...round.review, head: SCENARIO_NEXT_HEAD },
              },
            ],
          },
        }));
      });
      // This must complete before releasing GitHub, with an independent store/lock context.
      await replacement;
      const during = await world.store.read(SCENARIO_TASK_ID);
      expect(during?.generation).toBe(1);
      expect(during?.prReview?.rounds[0]?.pendingPost?.verdict).toBe("approve");
      expect(during?.prReview?.rounds[1]?.posted).toBeUndefined();
      release.resolve();
      expect(await submitted).toMatchObject({ posted: true });
      await replacement;
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ commit_id: SCENARIO_HEAD, event: "APPROVE" });
      const current = await service.get(SCENARIO_TASK_ID);
      expect(current.objective).toBe("Changed while the POST is in flight");
      expect(current.generation).toBe(1);
      expect(current.prReview?.rounds[0]?.posted).toBeDefined();
      expect(current.prReview?.rounds[1]?.posted).toBeUndefined();
      await expect(service.reviewSubmit(SCENARIO_TASK_ID, submission, expected)).rejects.toThrow(
        "The displayed PR review is stale",
      );
      expect(payloads).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([submitted, ...(replacement === undefined ? [] : [replacement])]);
      await service.shutdown();
    }
  });
}, 20_000);

test("simultaneous chat and native preflight can claim only one POST", async () => {
  await withScenario({}, async (world) => {
    const { state } = await seedReview(world);
    const headsReady = Promise.withResolvers<void>();
    let heads = 0;
    let posts = 0;
    const run: CommandRunner = async (request) => {
      if (request.argv[0] !== "gh") return world.run(request);
      if (request.argv.includes("--slurp")) return { code: 0, stdout: "[[]]", stderr: "" };
      if (request.argv.includes("headRefOid")) {
        heads += 1;
        if (heads === 2) headsReady.resolve();
        await headsReady.promise;
        return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
      }
      if (request.argv.includes("POST")) {
        posts += 1;
        expect(
          (await world.store.read(SCENARIO_TASK_ID))?.prReview?.rounds[0]?.pendingPost,
        ).toBeDefined();
        return {
          code: 0,
          stdout: JSON.stringify({ html_url: `${state.url}#review-1` }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
    };
    const chat = reviewService(world, run);
    const native = reviewService(world, run);
    try {
      const results = await Promise.allSettled([
        chat.reviewPost(SCENARIO_TASK_ID, { verdict: "approve", approved: true }),
        native.reviewSubmit(
          SCENARIO_TASK_ID,
          { tandemPrReview: 1, verdict: "approve", summary: "Approved", drafts: [], yours: [] },
          { head: SCENARIO_HEAD, generation: 0 },
        ),
      ]);
      expect(heads).toBe(2);
      expect(posts).toBe(1);
      expect(results.filter((result) => result.status === "fulfilled")).toMatchObject([
        { value: { posted: true } },
      ]);
      expect(results.filter((result) => result.status === "rejected")).toMatchObject([
        { reason: { name: "StaleTaskRevisionError" } },
      ]);
    } finally {
      headsReady.resolve();
      await Promise.all([chat.shutdown(), native.shutdown()]);
    }
  });
}, 20_000);

test("overlapping marker reconciliation saves one receipt and sends thread replies once", async () => {
  await withScenario({}, async (world) => {
    const { round, state } = await seedReview(world);
    const initial = await world.store.read(SCENARIO_TASK_ID);
    if (initial === undefined) throw new Error("Missing scenario task");
    await world.store.update(initial.id, initial.revision, (task) => ({
      ...task,
      revision: task.revision + 1,
      prReview: {
        ...state,
        rounds: [
          {
            ...round,
            review: {
              ...round.review,
              priorComments: [{ commentId: 42, status: "addressed", reply: "Thanks!" }],
            },
          },
        ],
      },
    }));
    const posting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let landed = false;
    let posts = 0;
    let replies = 0;
    const run: CommandRunner = async (request) => {
      if (request.argv[0] !== "gh") return world.run(request);
      if (request.argv.includes("--slurp"))
        return {
          code: 0,
          stdout: JSON.stringify([
            landed
              ? [{ body: reviewMarker(SCENARIO_TASK_ID, 0), html_url: `${state.url}#review-1` }]
              : [],
          ]),
          stderr: "",
        };
      if (request.argv.includes("headRefOid"))
        return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
      if (request.argv.some((arg) => arg.endsWith("/replies"))) {
        replies += 1;
        expect(
          (await world.store.read(SCENARIO_TASK_ID))?.prReview?.rounds[0]?.posted,
        ).toBeDefined();
        return { code: 0, stdout: "{}", stderr: "" };
      }
      if (request.argv.includes("POST")) {
        posts += 1;
        landed = true;
        posting.resolve();
        await release.promise;
        return {
          code: 0,
          stdout: JSON.stringify({ html_url: `${state.url}#review-1` }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
    };
    const native = reviewService(world, run);
    const chat = reviewService(world, run);
    const submitted = native.reviewSubmit(
      SCENARIO_TASK_ID,
      {
        tandemPrReview: 1,
        verdict: "request-changes",
        summary: "Saved choices",
        drafts: [],
        yours: [],
      },
      { head: SCENARIO_HEAD, generation: 0 },
    );
    try {
      await posting.promise;
      expect(
        await chat.reviewPost(SCENARIO_TASK_ID, { verdict: "approve", approved: true }),
      ).toMatchObject({ posted: true });
      expect(replies).toBe(1);
      release.resolve();
      expect(await submitted).toMatchObject({ posted: true });
      expect(posts).toBe(1);
      expect(replies).toBe(1);
      const saved = (await world.store.read(SCENARIO_TASK_ID))?.prReview?.rounds[0];
      expect(saved?.posted?.verdict).toBe("request-changes");
      expect(saved?.review.summaryComment).toBe("Saved choices");
    } finally {
      release.resolve();
      await Promise.allSettled([submitted]);
      await Promise.all([chat.shutdown(), native.shutdown()]);
    }
  });
}, 20_000);

test("uncertain posting offers explicit confirmed recovery and never reuses a confirmation for another attempt", async () => {
  await withScenario({}, async (world) => {
    const { state } = await seedReview(world);
    const payloads: unknown[] = [];
    let requests = 0;
    const service = reviewService(world, async (request) => {
      if (request.argv[0] !== "gh") return world.run(request);
      requests += 1;
      if (request.argv.includes("--slurp")) return { code: 0, stdout: "[[]]", stderr: "" };
      if (request.argv.includes("headRefOid"))
        return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
      if (request.argv.includes("POST")) {
        const saved = await world.store.read(SCENARIO_TASK_ID);
        expect(saved?.prReview?.rounds[0]?.pendingPost?.verdict).toBe("request-changes");
        payloads.push(JSON.parse(request.stdin ?? "{}"));
        return { code: 1, stdout: "", stderr: "response lost" };
      }
      throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
    });
    const submission: ReviewSubmission = {
      tandemPrReview: 1,
      verdict: "request-changes",
      summary: "The saved choices",
      drafts: [],
      yours: [],
    };
    const expected = { head: SCENARIO_HEAD, generation: 0 };
    try {
      expect(await service.reviewSubmit(SCENARIO_TASK_ID, submission, expected)).toMatchObject({
        posted: false,
        message: expect.stringContaining("check the PR"),
      });
      expect((await service.reviewShow(SCENARIO_TASK_ID, { page: false })).text).toContain(
        "GitHub may or may not have received this review",
      );
      const before = await service.get(SCENARIO_TASK_ID);
      const action: TandemAction = {
        action: "review-post",
        taskId: SCENARIO_TASK_ID,
        verdict: "request-changes",
        recovery: { kind: "post-again", taskRevision: before.revision },
      };
      expect(tandemRequestSchema.safeParse({ request: action }).success).toBe(true);
      expect((await executeTandemAction(action, service, { confirm: undefined })).approved).toBe(
        false,
      );
      expect(
        (await executeTandemAction(action, service, { confirm: async () => false })).approved,
      ).toBe(false);
      await expect(
        service.reviewPost(SCENARIO_TASK_ID, {
          verdict: "request-changes",
          approved: false,
          recovery: { kind: "post-again", taskRevision: before.revision },
        }),
      ).rejects.toThrow("user's approval");
      expect(payloads).toHaveLength(1);

      const reposted = await executeTandemAction(action, service, {
        confirm: async (_title, message) => {
          expect(message).toContain("this can create a duplicate review");
          return true;
        },
      });
      expect(reposted.value).toMatchObject({
        posted: false,
        message: expect.stringContaining("check the PR"),
      });
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toEqual(payloads[0]);
      // Both attempts use the fixture's identical clock; the durable revision still binds consent.
      await expect(
        executeTandemAction(action, service, { confirm: undefined, confirmedInConversation: true }),
      ).rejects.toThrow("review changed since you checked it");
      await service.reviewSubmit(SCENARIO_TASK_ID, submission, expected);
      expect(payloads).toHaveLength(2);

      const pending = await service.get(SCENARIO_TASK_ID);
      const recovery = {
        kind: "mark-posted" as const,
        taskRevision: pending.revision,
        url: `${state.url}#pullrequestreview-77`,
      };
      for (const url of [
        "https://github.com/other/repo/pull/7#pullrequestreview-77",
        state.url,
        "https://example.com/owner/repo/pull/7#pullrequestreview-77",
      ]) {
        await expect(
          service.reviewPost(SCENARIO_TASK_ID, {
            verdict: "request-changes",
            approved: true,
            recovery: { ...recovery, url },
          }),
        ).rejects.toThrow("GitHub review link");
      }
      const mark: TandemAction = {
        action: "review-post",
        taskId: SCENARIO_TASK_ID,
        verdict: "request-changes",
        recovery,
      };
      expect(tandemRequestSchema.safeParse({ request: mark }).success).toBe(true);
      expect(
        (await executeTandemAction(mark, service, { confirm: async () => false })).approved,
      ).toBe(false);
      const requestsBeforeMarking = requests;
      const marked = await executeTandemAction(mark, service, {
        confirm: async (_title, message) => {
          expect(message).toContain("without posting to GitHub");
          return true;
        },
      });
      expect(marked.value).toMatchObject({ posted: true, url: recovery.url });
      expect(requests).toBe(requestsBeforeMarking);
      expect(payloads).toHaveLength(2);
      const confirmed = await service.get(SCENARIO_TASK_ID);
      expect(confirmed.prReview?.rounds[0]?.posted).toMatchObject({
        url: recovery.url,
        verdict: "request-changes",
        confirmedByUser: true,
      });
      expect(confirmed.prReview?.rounds[0]?.pendingPost).toBeUndefined();
      expect(confirmed.prReview?.rounds[0]?.review.summaryComment).toBe(submission.summary);
      expect(
        await service.reviewPost(SCENARIO_TASK_ID, { verdict: "request-changes", approved: true }),
      ).toMatchObject({ posted: true, url: recovery.url });
      expect(payloads).toHaveLength(2);
    } finally {
      await service.shutdown();
    }
  });
}, 20_000);

for (const refused of ["moved-head", "unreadable-head", "unreadable-markers"] as const) {
  test(`confirmed repost preserves uncertainty when preflight has ${refused}`, async () => {
    await withScenario({}, async (world) => {
      await seedReview(world);
      let posts = 0;
      let retrying = false;
      const service = reviewService(world, async (request) => {
        if (request.argv[0] !== "gh") return world.run(request);
        if (request.argv.includes("--slurp"))
          return retrying && refused === "unreadable-markers"
            ? { code: 1, stdout: "", stderr: "offline" }
            : { code: 0, stdout: "[[]]", stderr: "" };
        if (request.argv.includes("headRefOid"))
          return retrying && refused === "unreadable-head"
            ? { code: 1, stdout: "", stderr: "offline" }
            : {
                code: 0,
                stdout: retrying && refused === "moved-head" ? SCENARIO_NEXT_HEAD : SCENARIO_HEAD,
                stderr: "",
              };
        if (request.argv.includes("POST")) {
          posts += 1;
          return { code: 1, stdout: "", stderr: "response lost" };
        }
        throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
      });
      try {
        await service.reviewPost(SCENARIO_TASK_ID, { verdict: "approve", approved: true });
        const pending = await service.get(SCENARIO_TASK_ID);
        retrying = true;
        const result = await service.reviewPost(SCENARIO_TASK_ID, {
          verdict: "approve",
          approved: true,
          recovery: { kind: "post-again", taskRevision: pending.revision },
        });
        expect(result).toMatchObject({
          posted: false,
          message: expect.stringContaining("GitHub may or may not have received this review"),
        });
        expect(posts).toBe(1);
        expect((await service.get(SCENARIO_TASK_ID)).prReview).toEqual(pending.prReview);
      } finally {
        await service.shutdown();
      }
    });
  }, 20_000);
}

for (const first of ["chat", "native"] as const) {
  test(`${first} posting's durable claim prevents an overlapping ${first === "chat" ? "native" : "chat"} POST`, async () => {
    await withScenario({}, async (world) => {
      const { state } = await seedReview(world);
      const posting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const payloads: unknown[] = [];
      const run: CommandRunner = async (request) => {
        if (request.argv[0] !== "gh") return world.run(request);
        if (request.argv.includes("--slurp")) return { code: 0, stdout: "[[]]", stderr: "" };
        if (request.argv.includes("headRefOid"))
          return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
        if (request.argv.includes("POST")) {
          // The uncertain submission must already be durable when GitHub is called.
          const durable = await world.store.read(SCENARIO_TASK_ID);
          expect(durable?.prReview?.rounds[0]?.pendingPost).toMatchObject({ verdict: "approve" });
          payloads.push(JSON.parse(request.stdin ?? "{}"));
          posting.resolve();
          await release.promise;
          return {
            code: 0,
            stdout: JSON.stringify({ html_url: `${state.url}#review-1` }),
            stderr: "",
          };
        }
        throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
      };
      // Separate controllers share durable state, as chat and a native CLI process do.
      const chat = reviewService(world, run);
      const native = reviewService(world, run);
      const submission: ReviewSubmission = {
        tandemPrReview: 1,
        verdict: "approve",
        summary: "Approved",
        drafts: [],
        yours: [],
      };
      const chatPost = () =>
        chat.reviewPost(SCENARIO_TASK_ID, { verdict: "approve", approved: true });
      const nativePost = () =>
        native.reviewSubmit(SCENARIO_TASK_ID, submission, { head: SCENARIO_HEAD, generation: 0 });
      const submitted = first === "chat" ? chatPost() : nativePost();
      let overlapping: Promise<unknown> | undefined;
      try {
        await posting.promise;
        overlapping = first === "chat" ? nativePost() : chatPost();
        // Observe rejection immediately, including on a regression, to avoid an unhandled promise.
        const result = overlapping.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const other = await result;
        expect(other).toMatchObject({
          value: {
            posted: false,
            message: expect.stringContaining("GitHub may or may not have received this review"),
          },
        });
        expect(payloads).toHaveLength(1);
        release.resolve();
        expect(await submitted).toMatchObject({ posted: true });
        if (first === "chat") {
          await expect(nativePost()).rejects.toThrow("This review was already posted");
        } else {
          expect(await chatPost()).toMatchObject({ posted: true });
        }
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          body: expect.stringContaining(reviewMarker(SCENARIO_TASK_ID, 0)),
        });
        const durable = await world.store.read(SCENARIO_TASK_ID);
        expect(durable?.prReview?.rounds[0]?.posted?.verdict).toBe("approve");
        expect(durable?.prReview?.rounds[0]?.pendingPost).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.allSettled([submitted, ...(overlapping === undefined ? [] : [overlapping])]);
        await Promise.all([chat.shutdown(), native.shutdown()]);
      }
    });
  }, 20_000);
}

test("an accepted review with a lost response remains quarantined across restart until its marker is readable", async () => {
  await withScenario({}, async (world) => {
    const { state } = await seedReview(world);
    let landed = false;
    let markers: "unreadable" | "absent" | "found" = "unreadable";
    const payloads: unknown[] = [];
    const run: CommandRunner = async (request) => {
      if (request.argv[0] !== "gh") return world.run(request);
      if (request.argv.includes("--slurp")) {
        if (landed && markers === "unreadable") return { code: 1, stdout: "", stderr: "offline" };
        return {
          code: 0,
          stdout: JSON.stringify([
            landed && markers === "found"
              ? [{ body: reviewMarker(SCENARIO_TASK_ID, 0), html_url: `${state.url}#review-1` }]
              : [],
          ]),
          stderr: "",
        };
      }
      if (request.argv.includes("headRefOid"))
        return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
      if (request.argv.includes("POST")) {
        const durable = await world.store.read(SCENARIO_TASK_ID);
        expect(durable?.prReview?.rounds[0]?.pendingPost?.verdict).toBe("request-changes");
        expect(durable?.prReview?.rounds[0]?.review.summaryComment).toBe(
          "Original approved choices",
        );
        payloads.push(JSON.parse(request.stdin ?? "{}"));
        landed = true;
        throw new Error("response lost after GitHub accepted the review");
      }
      throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
    };
    const submission: ReviewSubmission = {
      tandemPrReview: 1,
      verdict: "request-changes",
      summary: "Original approved choices",
      drafts: [],
      yours: [],
    };
    const expected = { head: SCENARIO_HEAD, generation: 0 };
    const service = reviewService(world, run);
    try {
      expect(await service.reviewSubmit(SCENARIO_TASK_ID, submission, expected)).toMatchObject({
        posted: false,
        message: expect.stringContaining("GitHub may or may not have received this review"),
      });
      expect(payloads).toHaveLength(1);
    } finally {
      await service.shutdown();
    }

    const restarted = reviewService(world, run);
    try {
      const changed = {
        ...submission,
        verdict: "approve" as const,
        summary: "Changed choices must not replace an uncertain submission",
      };
      expect(await restarted.reviewSubmit(SCENARIO_TASK_ID, changed, expected)).toMatchObject({
        posted: false,
        message: expect.stringContaining("Cannot read GitHub review markers"),
      });
      await expect(
        restarted.reviewEdit(SCENARIO_TASK_ID, { summaryComment: "Changed" }),
      ).rejects.toThrow("uncertain post");
      markers = "absent";
      expect(
        await restarted.reviewPost(SCENARIO_TASK_ID, { verdict: "approve", approved: true }),
      ).toMatchObject({
        posted: false,
        message: expect.stringContaining("has not returned the saved marker"),
      });
      expect(payloads).toHaveLength(1);
      markers = "found";
      expect(await restarted.reviewSubmit(SCENARIO_TASK_ID, changed, expected)).toMatchObject({
        posted: true,
        url: `${state.url}#review-1`,
      });
      expect(payloads).toHaveLength(1);
      const durable = await world.store.read(SCENARIO_TASK_ID);
      expect(durable?.prReview?.rounds[0]?.posted?.verdict).toBe("request-changes");
      expect(durable?.prReview?.rounds[0]?.pendingPost).toBeUndefined();
      expect(durable?.prReview?.rounds[0]?.review.summaryComment).toBe(submission.summary);
    } finally {
      await restarted.shutdown();
    }
  });
}, 20_000);
