import { checkoutQuestion, findCheckout, type RepoLocation } from "../repos/locate.ts";
import {
  acknowledgement,
  findPullRequestRef,
  isRefusal,
  type PullRequestFacts,
  readPullRequest,
} from "./pull-request.ts";
import type { ReviewLens } from "./review.ts";
import type { PrReviewDependencies, StartPrReviewInput, StartPrReviewResult } from "./service.ts";
import { lensLabel, type PrReviewState } from "./state.ts";

type StartDependencies = Pick<
  PrReviewDependencies,
  "home" | "run" | "clock" | "projectRoots" | "listTasks" | "createTask"
>;

export async function startPrReview(
  deps: StartDependencies,
  input: StartPrReviewInput,
): Promise<StartPrReviewResult> {
  const ref = findPullRequestRef(input.pullRequest);
  if (ref === undefined) {
    return { kind: "refused", message: "That doesn't look like a GitHub pull request link." };
  }
  const existing = (await deps.listTasks()).find(
    (candidate) =>
      candidate.prReview !== undefined &&
      candidate.prReview.closed !== true &&
      candidate.stage !== "cancelled" &&
      candidate.prReview.ref.repo === ref.repo &&
      candidate.prReview.ref.number === ref.number,
  );
  if (existing !== undefined) {
    return {
      kind: "existing",
      taskId: existing.id,
      message: `I'm already reviewing ${ref.repo}#${ref.number} as task ${existing.id}. Ask for a re-review to look at new pushes.`,
    };
  }
  const facts = await readPullRequest(deps.run, ref, deps.home);
  if (isRefusal(facts)) return facts;
  const location = await findCheckout(ref.repo, input, {
    home: deps.home,
    run: deps.run,
    clock: deps.clock,
    roots: await deps.projectRoots(),
  });
  if (location.kind !== "found") {
    return {
      kind: "needs-location",
      repo: ref.repo,
      paths: location.kind === "ambiguous" ? location.paths : [],
      message: checkoutQuestion(ref.repo, location, input.checkout),
      nextStep:
        "Ask the user this, then call review-pr again with checkout set to their path, or clone true if they say to clone it.",
    };
  }
  const lens = input.lens ?? { kind: "full" };
  const task = await deps.createTask({
    repoPath: input.repoPath,
    objective: `Review ${ref.repo}#${ref.number}: ${facts.title || "pull request"}`,
    prReview: stateFor(facts, location, lens),
  });
  return { kind: "started", taskId: task.id, message: acknowledgement(facts, lensLabel(lens)) };
}

function stateFor(
  facts: PullRequestFacts,
  location: Extract<RepoLocation, { kind: "found" }>,
  lens: ReviewLens,
): PrReviewState {
  return {
    ref: facts.ref,
    url: facts.url,
    title: facts.title,
    author: facts.author,
    baseRef: facts.baseRef,
    checkout: location.path,
    remote: location.remote,
    lens,
    mode: "review",
    rounds: [],
  };
}
