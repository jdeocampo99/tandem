import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NativeViewsReader } from "../../src/board/native-read.ts";
import { boardView } from "../../src/board/view.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import { reviewPageInput } from "../../src/pr-review/page-input.ts";
import { reviewMarker } from "../../src/pr-review/post.ts";
import { createPrReviewWorkflow } from "../../src/pr-review/service.ts";
import {
  type PrReviewRound,
  type PrReviewState,
  prReviewRunDiffPath,
} from "../../src/pr-review/state.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { executeTandemAction, type TandemAction } from "../../src/session/actions.ts";
import { tandemRequestSchema } from "../../src/session/tools.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { state as boardState } from "../board/fixtures.ts";
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
      if (request.argv.includes("POST") && request.argv.some((arg) => arg.endsWith("/comments"))) {
        replies += 1;
        const saved = (await world.store.read(SCENARIO_TASK_ID))?.prReview?.rounds[0];
        expect(saved?.posted).toBeDefined();
        expect(saved?.replyPosts).toMatchObject([{ index: 0, kind: "pending" }]);
        return {
          code: 0,
          stdout: JSON.stringify({ in_reply_to_id: 42, html_url: `${state.url}#discussion_r43` }),
          stderr: "",
        };
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

const threadReply = {
  threadId: "thread-22",
  commentId: "node-22",
  replyTo: 22,
  body: "Keep this guard, thanks.",
};
const replyUrl = "https://github.com/owner/repo/pull/7#discussion_r23";
const replySubmission: ReviewSubmission = {
  tandemPrReview: 1,
  verdict: "comment",
  summary: "Saved review",
  drafts: [],
  yours: [],
  replies: [threadReply],
};

type ReplyCrash = "review-receipt" | "claim" | "reply-receipt" | "first-reply-receipt";

function replyBoundary(world: ScenarioWorld, lost = false) {
  const replies: unknown[] = [];
  let reviewPosts = 0;
  let found = false;
  let unreadable = false;
  const run: CommandRunner = async (request) => {
    if (request.argv[0] !== "gh") return world.run(request);
    if (unreadable) return { code: 1, stdout: "", stderr: "offline" };
    const endpoint = request.argv.find((arg) => arg.startsWith("repos/")) ?? "";
    if (request.argv.includes("POST")) {
      const payload: unknown = JSON.parse(request.stdin ?? "{}");
      if (endpoint.endsWith("/reviews")) {
        reviewPosts++;
        return {
          code: 0,
          stdout: JSON.stringify({
            html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
          }),
          stderr: "",
        };
      }
      expect(
        (await world.store.read(SCENARIO_TASK_ID))?.prReview?.rounds[0]?.replyPosts,
      ).toMatchObject([{ index: 0, kind: "pending" }]);
      replies.push(payload);
      return lost
        ? { code: 1, stdout: "", stderr: "reply response lost" }
        : {
            code: 0,
            stdout: JSON.stringify({ in_reply_to_id: 22, html_url: replyUrl }),
            stderr: "",
          };
    }
    if (request.argv.includes("--slurp"))
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          found && endpoint.endsWith("/comments")
            ? [
                {
                  body: `<!-- tandem-reply:${SCENARIO_TASK_ID}:0:0 -->`,
                  in_reply_to_id: 22,
                  html_url: replyUrl,
                },
              ]
            : [],
        ]),
      };
    if (request.argv[1] === "api" && request.argv[2] === "graphql")
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: SCENARIO_HEAD,
                reviewThreads: {
                  nodes: [
                    {
                      id: threadReply.threadId,
                      path: "removed.ts",
                      line: null,
                      diffSide: "LEFT",
                      isResolved: false,
                      isOutdated: true,
                      comments: {
                        nodes: [
                          {
                            id: threadReply.commentId,
                            databaseId: 22,
                            author: { login: "sam" },
                            createdAt: world.clock(),
                            body: "Earlier guard",
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      };
    if (request.argv.includes("headRefOid"))
      return {
        code: 0,
        stdout: request.argv.includes("--jq")
          ? SCENARIO_HEAD
          : JSON.stringify({ headRefOid: SCENARIO_HEAD }),
        stderr: "",
      };
    if (request.argv.includes("--json"))
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          number: 7,
          title: "A change",
          url: "https://github.com/owner/repo/pull/7",
          headRefOid: SCENARIO_HEAD,
          isDraft: false,
          body: "Change",
          commits: [],
          additions: 0,
          deletions: 0,
          statusCheckRollup: [],
          comments: [],
          reviews: [],
        }),
      };
    if (request.argv[2] === "diff") return { code: 0, stdout: "", stderr: "" };
    return world.run(request);
  };
  return {
    run,
    replies,
    reviewPosts: () => reviewPosts,
    showMarker: () => {
      found = true;
    },
    offline: () => {
      unreadable = true;
    },
  };
}

function crashReplyWorkflow(world: ScenarioWorld, run: CommandRunner, crash: ReplyCrash) {
  return createPrReviewWorkflow({
    home: world.home,
    run,
    clock: world.clock,
    projectRoots: async () => [],
    listTasks: () => world.store.list(),
    getTask: async (id) => {
      const saved = await world.store.read(id);
      if (!saved) throw new Error("Missing task");
      return saved;
    },
    createTask: async () => {
      throw new Error("Unexpected creation");
    },
    updatePrReview: async (task, next) => {
      const saved = await world.store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        prReview: next,
      }));
      if (crash === "claim" && next.rounds[0]?.replyPosts?.[0]?.kind === "pending")
        throw new Error("crash after reply claim");
      return saved;
    },
    mutatePrReview: async (id, update) => {
      const result = await world.store.exclusive(async (store) => {
        const task = await store.read(id);
        if (!task) throw new Error("Missing task");
        const next = update(task);
        if (crash === "reply-receipt" && next.rounds[0]?.replyPosts?.[0]?.kind === "posted")
          throw new Error("crash before reply receipt save");
        if (next === task.prReview) return { task, changed: false };
        const saved = await store.update(id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          prReview: next,
        }));
        return { task: saved, changed: true };
      });
      if (crash === "review-receipt" && result.task.prReview?.rounds[0]?.posted)
        throw new Error("crash after review receipt save");
      if (
        crash === "first-reply-receipt" &&
        result.task.prReview?.rounds[0]?.replyPosts?.some((post) => post.kind === "posted")
      )
        throw new Error("crash after the first reply receipt");
      return result;
    },
    runAgain: async () => undefined,
    settle: async () => undefined,
  });
}

for (const crash of ["lost-response", "review-receipt", "claim", "reply-receipt"] as const) {
  test(`saved reply text survives reload after ${crash}; an unclaimed reply is sent once and a claimed one is never retried`, async () => {
    await withScenario({}, async (world) => {
      await seedReview(world);
      const boundary = replyBoundary(world, crash === "lost-response");
      if (crash === "lost-response") {
        const first = reviewService(world, boundary.run);
        try {
          expect(await first.reviewSubmit(SCENARIO_TASK_ID, replySubmission)).toMatchObject({
            posted: true,
            message: expect.stringContaining("no confirmed receipt"),
          });
        } finally {
          await first.shutdown();
        }
      } else {
        await expect(
          crashReplyWorkflow(world, boundary.run, crash).submit(SCENARIO_TASK_ID, replySubmission),
        ).rejects.toThrow("crash");
      }
      const restarted = reviewService(world, boundary.run);
      const before = boundary.replies.length;
      try {
        const saved = await restarted.get(SCENARIO_TASK_ID);
        expect(saved.prReview?.rounds[0]?.posted).toBeDefined();
        expect(saved.prReview?.rounds[0]?.review.replies).toEqual([threadReply]);
        if (crash === "lost-response")
          expect(saved.prReview?.rounds[0]?.replyPosts?.[0]).toMatchObject({
            kind: "uncertain",
            message: "reply response lost",
          });
        if (crash === "claim" || crash === "reply-receipt")
          expect(saved.prReview?.rounds[0]?.replyPosts?.[0]?.kind).toBe("pending");
        const show = await restarted.reviewShow(SCENARIO_TASK_ID, { page: false });
        expect(show.text).toContain(threadReply.body);
        expect(show.text).toContain("Tandem will not automatically retry");
        const round = saved.prReview?.rounds[0];
        if (!round || !saved.prReview) throw new Error("Missing round");
        expect(reviewPageInput(saved.prReview, round, "", {}).notes.join("\n")).toContain(
          "no confirmed receipt",
        );
        const nativeReader = new NativeViewsReader({
          home: world.home,
          clock: world.clock,
          run: boundary.run,
          terminal: terminalBackend(world.run),
        });
        const snapshot = {
          version: 1 as const,
          writtenAt: world.clock(),
          board: boardView(boardState({ projects: [world.repoPath] }), world.clock()),
          coordinators: [],
        };
        await nativeReader.read(snapshot, world.repoPath);
        await nativeReader.settle();
        const publication = await nativeReader.read(snapshot, world.repoPath);
        const pr = publication.details.find((entry) => entry.view.kind === "pr")?.view;
        expect(pr?.kind === "pr" ? pr.data.review?.notes.join("\n") : undefined).toContain(
          "no confirmed receipt",
        );
        await nativeReader.settle();
        // Only a reply that never claimed its attempt is sent on re-entry; a claim is never retried.
        const unclaimed = crash === "review-receipt";
        const sent = before + (unclaimed ? 1 : 0);
        expect(
          await restarted.reviewPost(SCENARIO_TASK_ID, { verdict: "comment", approved: true }),
        ).toMatchObject(
          unclaimed
            ? { posted: true, message: expect.stringContaining(replyUrl) }
            : { posted: true, message: expect.stringContaining("no confirmed receipt") },
        );
        expect(boundary.replies.length).toBe(sent);
        expect(boundary.reviewPosts()).toBe(1);
        if (sent > 0) {
          if (!unclaimed) boundary.showMarker();
          expect(
            await restarted.reviewPost(SCENARIO_TASK_ID, { verdict: "comment", approved: true }),
          ).toMatchObject({ message: expect.stringContaining(replyUrl) });
          const receipt = (await restarted.get(SCENARIO_TASK_ID)).prReview?.rounds[0]
            ?.replyPosts?.[0];
          expect(receipt).toMatchObject({ index: 0, kind: "posted", url: replyUrl });
          expect(
            (await restarted.reviewShow(SCENARIO_TASK_ID, { page: false })).text,
          ).not.toContain("no confirmed receipt");
          expect(boundary.replies.length).toBe(sent);
        }
      } finally {
        await restarted.shutdown();
      }
    });
  }, 20_000);
}

/** A small GitHub that remembers every reply it accepted and serves it back with its marker. */
function priorReplyGitHub(world: ScenarioWorld, prUrl: string) {
  const replies: Record<string, unknown>[] = [];
  let reviewPosts = 0;
  const run: CommandRunner = async (request) => {
    if (request.argv[0] !== "gh") return world.run(request);
    const endpoint = request.argv.find((arg) => arg.startsWith("repos/")) ?? "";
    if (request.argv.includes("--slurp"))
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          endpoint.endsWith("/comments")
            ? replies
            : reviewPosts === 0
              ? []
              : [{ body: reviewMarker(SCENARIO_TASK_ID, 0), html_url: `${prUrl}#review-1` }],
        ]),
      };
    if (request.argv.includes("headRefOid")) return { code: 0, stdout: SCENARIO_HEAD, stderr: "" };
    if (request.argv.includes("POST") && endpoint.endsWith("/reviews")) {
      reviewPosts += 1;
      return { code: 0, stdout: JSON.stringify({ html_url: `${prUrl}#review-1` }), stderr: "" };
    }
    if (request.argv.includes("POST") && endpoint.endsWith("/comments")) {
      const payload = JSON.parse(request.stdin ?? "{}") as Record<string, unknown>;
      const receipt = {
        in_reply_to_id: payload.in_reply_to,
        body: payload.body,
        html_url: `${prUrl}#discussion_r${100 + replies.length}`,
      };
      replies.push(receipt);
      return { code: 0, stdout: JSON.stringify(receipt), stderr: "" };
    }
    throw new Error(`Unexpected GitHub request ${JSON.stringify(request.argv)}`);
  };
  return { run, replies, reviewPosts: () => reviewPosts };
}

test("replies to addressed earlier comments survive a crash mid-loop and each posts exactly once", async () => {
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
              priorComments: [
                { commentId: 42, status: "addressed", reply: "Thanks, this is capped now." },
                { commentId: 43, status: "not-addressed" },
                { commentId: 44, status: "addressed", reply: "Logged per attempt, thanks." },
              ],
            },
          },
        ],
      },
    }));
    const github = priorReplyGitHub(world, state.url);
    await expect(
      crashReplyWorkflow(world, github.run, "first-reply-receipt").submit(SCENARIO_TASK_ID, {
        tandemPrReview: 1,
        verdict: "comment",
        summary: "Saved review",
        drafts: [],
        yours: [],
      }),
    ).rejects.toThrow("crash after the first reply receipt");
    expect(github.replies.map((reply) => reply.in_reply_to_id)).toEqual([42]);
    const restarted = reviewService(world, github.run);
    try {
      const crashed = (await restarted.get(SCENARIO_TASK_ID)).prReview?.rounds[0];
      expect(crashed?.posted).toBeDefined();
      expect(crashed?.replyPosts).toMatchObject([{ index: 0, kind: "posted" }]);
      expect(
        await restarted.reviewPost(SCENARIO_TASK_ID, { verdict: "comment", approved: true }),
      ).toMatchObject({ posted: true });
      expect(github.replies.map((reply) => reply.in_reply_to_id)).toEqual([42, 44]);
      expect(github.replies.map((reply) => reply.body)).toEqual([
        expect.stringContaining("Thanks, this is capped now."),
        expect.stringContaining("Logged per attempt, thanks."),
      ]);
      expect((await restarted.get(SCENARIO_TASK_ID)).prReview?.rounds[0]?.replyPosts).toMatchObject(
        [
          { index: 0, kind: "posted", url: `${state.url}#discussion_r100` },
          { index: 1, kind: "posted", url: `${state.url}#discussion_r101` },
        ],
      );
      expect(
        await restarted.reviewPost(SCENARIO_TASK_ID, { verdict: "comment", approved: true }),
      ).toMatchObject({ posted: true });
      expect(github.replies).toHaveLength(2);
      expect(github.reviewPosts()).toBe(1);
    } finally {
      await restarted.shutdown();
    }
  });
}, 20_000);

test("reply recovery requires exact revision and explicit duplicate warning or a checked same-PR receipt", async () => {
  await withScenario({}, async (world) => {
    await seedReview(world);
    const boundary = replyBoundary(world, true);
    const service = reviewService(world, boundary.run);
    try {
      await service.reviewSubmit(SCENARIO_TASK_ID, replySubmission);
      const saved = await service.get(SCENARIO_TASK_ID);
      const action: TandemAction = {
        action: "review-post",
        taskId: saved.id,
        verdict: "comment",
        recovery: { kind: "post-reply-again", taskRevision: saved.revision, replyIndex: 0 },
      };
      expect(tandemRequestSchema.safeParse({ request: action }).success).toBe(true);
      expect((await executeTandemAction(action, service, { confirm: undefined })).approved).toBe(
        false,
      );
      expect(
        (await executeTandemAction(action, service, { confirm: async () => false })).approved,
      ).toBe(false);
      expect(boundary.replies).toHaveLength(1);
      await expect(
        service.reviewPost(saved.id, {
          verdict: "comment",
          approved: false,
          recovery: { kind: "post-reply-again", taskRevision: saved.revision, replyIndex: 0 },
        }),
      ).rejects.toThrow("user's approval");
      await executeTandemAction(action, service, {
        confirm: async (_title, message) => {
          expect(message).toContain("duplicate reply");
          return true;
        },
      });
      expect(boundary.replies).toHaveLength(2);
      expect(boundary.replies[1]).toEqual(boundary.replies[0]);
      await expect(
        executeTandemAction(action, service, { confirm: undefined, confirmedInConversation: true }),
      ).rejects.toThrow("changed since you checked it");
      const pending = await service.get(saved.id);
      for (const url of [
        "https://github.com/other/repo/pull/7#discussion_r23",
        "https://github.com/owner/repo/pull/7#pullrequestreview-1",
      ])
        await expect(
          service.reviewPost(saved.id, {
            verdict: "comment",
            approved: true,
            recovery: {
              kind: "mark-reply-posted",
              taskRevision: pending.revision,
              replyIndex: 0,
              url,
            },
          }),
        ).rejects.toThrow("same PR");
      boundary.offline();
      const marked = await executeTandemAction(
        {
          action: "review-post",
          taskId: saved.id,
          verdict: "comment",
          recovery: {
            kind: "mark-reply-posted",
            taskRevision: pending.revision,
            replyIndex: 0,
            url: replyUrl,
          },
        },
        service,
        {
          confirm: async (_title, message) => {
            expect(message).toContain("reply link you checked");
            return true;
          },
        },
      );
      expect(marked.value).toMatchObject({
        posted: true,
        message: expect.stringContaining(replyUrl),
      });
      expect((await service.get(saved.id)).prReview?.rounds[0]?.replyPosts?.[0]).toMatchObject({
        kind: "posted",
        confirmedByUser: true,
        url: replyUrl,
      });
      expect(boundary.replies).toHaveLength(2);
    } finally {
      await service.shutdown();
    }
  });
}, 20_000);

test("competing confirmed reply recovery calls claim only one POST", async () => {
  await withScenario({}, async (world) => {
    await seedReview(world);
    const boundary = replyBoundary(world, true);
    const first = reviewService(world, boundary.run);
    await first.reviewSubmit(SCENARIO_TASK_ID, replySubmission);
    await first.shutdown();
    const saved = await world.store.read(SCENARIO_TASK_ID);
    if (!saved) throw new Error("Missing saved task");
    const ready = Promise.withResolvers<void>();
    let heads = 0;
    const run: CommandRunner = async (request) => {
      if (request.argv.includes("headRefOid") && request.argv.includes("--jq")) {
        if (++heads === 2) ready.resolve();
        await ready.promise;
      }
      return boundary.run(request);
    };
    const a = reviewService(world, run);
    const b = reviewService(world, run);
    try {
      const input = {
        verdict: "comment" as const,
        approved: true,
        recovery: {
          kind: "post-reply-again" as const,
          taskRevision: saved.revision,
          replyIndex: 0,
        },
      };
      const results = await Promise.allSettled([
        a.reviewPost(saved.id, input),
        b.reviewPost(saved.id, input),
      ]);
      expect(heads).toBe(2);
      expect(boundary.replies).toHaveLength(2); // Original plus one confirmed attempt.
      expect(results.filter((result) => result.status === "rejected")).toMatchObject([
        { reason: { name: "StaleTaskRevisionError" } },
      ]);
      expect(boundary.reviewPosts()).toBe(1);
      expect((await world.store.read(saved.id))?.prReview?.rounds[0]?.replyPosts?.[0]?.kind).toBe(
        "uncertain",
      );
    } finally {
      ready.resolve();
      await Promise.all([a.shutdown(), b.shutdown()]);
    }
  });
}, 20_000);

test("reply preflight failure is saved and remains visible after task reload", async () => {
  await withScenario({}, async (world) => {
    await seedReview(world);
    const boundary = replyBoundary(world);
    let heads = 0;
    const run: CommandRunner = async (request) => {
      if (request.argv.includes("headRefOid") && request.argv.includes("--jq") && ++heads > 1)
        return { code: 0, stdout: SCENARIO_NEXT_HEAD, stderr: "" };
      return boundary.run(request);
    };
    const first = reviewService(world, run);
    try {
      await first.reviewSubmit(SCENARIO_TASK_ID, replySubmission);
    } finally {
      await first.shutdown();
    }
    const restarted = reviewService(world, run);
    try {
      expect(
        (await restarted.get(SCENARIO_TASK_ID)).prReview?.rounds[0]?.replyPosts?.[0],
      ).toMatchObject({
        index: 0,
        kind: "failed",
        message: `The PR moved to ${SCENARIO_NEXT_HEAD}.`,
      });
      expect((await restarted.reviewShow(SCENARIO_TASK_ID, { page: false })).text).toContain(
        `The PR moved to ${SCENARIO_NEXT_HEAD}.`,
      );
      expect(boundary.replies).toHaveLength(0);
    } finally {
      await restarted.shutdown();
    }
  });
}, 20_000);

test("an older in-flight reply failure cannot overwrite a newer same-clock confirmed attempt", async () => {
  await withScenario({}, async (world) => {
    await seedReview(world);
    const boundary = replyBoundary(world, true);
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let posts = 0;
    const run: CommandRunner = async (request) => {
      if (request.argv.includes("POST") && request.argv.some((arg) => arg.endsWith("/comments"))) {
        if (++posts === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      }
      return boundary.run(request);
    };
    const first = reviewService(world, run);
    const recovery = reviewService(world, run);
    const original = first.reviewSubmit(SCENARIO_TASK_ID, replySubmission);
    const observedOriginal = original.then(
      () => undefined,
      (error: unknown) => error,
    );
    let recovered: ReturnType<typeof recovery.reviewPost> | undefined;
    try {
      await firstStarted.promise;
      const before = await recovery.get(SCENARIO_TASK_ID);
      const originalClaim = before.prReview?.rounds[0]?.replyPosts?.[0];
      expect(originalClaim?.kind).toBe("pending");
      recovered = recovery.reviewPost(SCENARIO_TASK_ID, {
        verdict: "comment",
        approved: true,
        recovery: { kind: "post-reply-again", taskRevision: before.revision, replyIndex: 0 },
      });
      await secondStarted.promise;
      const newerClaim = (await recovery.get(SCENARIO_TASK_ID)).prReview?.rounds[0]
        ?.replyPosts?.[0];
      expect(newerClaim?.kind).toBe("pending");
      if (originalClaim?.kind !== "pending" || newerClaim?.kind !== "pending")
        throw new Error("Missing pending claims");
      expect(newerClaim.attemptedAt).toBe(originalClaim.attemptedAt);
      expect(newerClaim.attemptRevision).toBeGreaterThan(originalClaim.attemptRevision);
      releaseFirst.resolve();
      expect(await observedOriginal).toMatchObject({
        message: "The saved reply attempt changed; inspect it again.",
      });
      expect((await recovery.get(SCENARIO_TASK_ID)).prReview?.rounds[0]?.replyPosts?.[0]).toEqual(
        newerClaim,
      );
      releaseSecond.resolve();
      await recovered;
      expect(
        (await recovery.get(SCENARIO_TASK_ID)).prReview?.rounds[0]?.replyPosts?.[0],
      ).toMatchObject({ kind: "uncertain", attemptRevision: newerClaim.attemptRevision });
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([original, ...(recovered === undefined ? [] : [recovered])]);
      await Promise.all([first.shutdown(), recovery.shutdown()]);
    }
  });
}, 20_000);
