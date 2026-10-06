import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import {
  type PrReviewRound,
  type PrReviewState,
  prReviewRunDiffPath,
} from "../../src/pr-review/state.ts";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  withScenario,
} from "./scenario.ts";

test("native submission holds its checked round through posting before a re-review can replace it", async () => {
  await withScenario({}, async (world) => {
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
    let replacementFinished = false;
    const submitted = service.reviewSubmit(SCENARIO_TASK_ID, submission, expected);
    try {
      await posting.promise;
      replacement = world.store.exclusive(async (store) => {
        const current = await store.read(SCENARIO_TASK_ID);
        if (current?.prReview === undefined) throw new Error("Missing scenario review");
        const currentReview = current.prReview;
        await store.update(current.id, current.revision, (task) => ({
          ...task,
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
        replacementFinished = true;
      });
      await Bun.sleep(50);
      expect(replacementFinished).toBe(false);
      release.resolve();
      expect(await submitted).toMatchObject({ posted: true });
      await replacement;
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ commit_id: SCENARIO_HEAD, event: "APPROVE" });
      const current = await service.get(SCENARIO_TASK_ID);
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
