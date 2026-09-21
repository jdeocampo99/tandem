import { readCheckpoint } from "../adapters/git.ts";
import type { CommandRunner, RequestIntegratedMember } from "../contracts.ts";
import { type DeliveryCheckout, deliveryCheckout, readGitText, runGit } from "./pull-requests.ts";

/** Why one member output could not be merged into the delivery branch without a human decision. */
export type IntegrationRefusal = Readonly<{
  readonly taskId: string;
  readonly detail: string;
}>;

export type IntegrationAttempt =
  | Readonly<{ readonly head: string; readonly refusal?: undefined }>
  | Readonly<{ readonly head?: undefined; readonly refusal: IntegrationRefusal }>;

export type IntegrationInput = Readonly<{
  readonly cwd: string;
  readonly branch: string;
  readonly baseHead: string;
  /** Member outputs in dependency order; each one is merged on top of the previous result. */
  readonly members: readonly RequestIntegratedMember[];
}>;

/**
 * Rebuilds the request delivery branch from the pinned base and merges each reviewed member commit
 * onto it. Every merge must apply cleanly: a merge that needs resolution is aborted and reported as
 * a refusal, so the integrated commit never contains content no member review covered.
 */
export async function mergeMembersOntoDeliveryBranch(
  run: CommandRunner,
  input: IntegrationInput,
): Promise<IntegrationAttempt> {
  if (input.members.length === 0) {
    throw new Error("integration requires at least one reviewed member output");
  }
  const checkpoint = await readCheckpoint(run, { repo: input.cwd });
  if (checkpoint.dirty || checkpoint.unmerged) {
    throw new Error("integration requires a clean delivery worktree with no unmerged paths");
  }
  await runGit(
    run,
    input.cwd,
    ["switch", "--no-overwrite-ignore", "--force-create", input.branch, input.baseHead],
    "request delivery branch reset",
  );
  for (const member of input.members) {
    const merge = await run({
      argv: [
        "git",
        "-C",
        input.cwd,
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Integrate ${member.taskId} into the request delivery branch`,
        member.head,
      ],
      cwd: input.cwd,
    });
    if (merge.code === 0) continue;
    await runGit(run, input.cwd, ["merge", "--abort"], "request delivery merge abort");
    return {
      refusal: {
        taskId: member.taskId,
        detail: `merging ${member.head} into ${input.branch} needs manual resolution: ${merge.stderr.trim() || merge.stdout.trim()}`,
      },
    };
  }
  return {
    head: await readGitText(run, input.cwd, ["rev-parse", "HEAD"], "request delivery head"),
  };
}

/** Proves the delivery worktree still holds exactly the integrated commit on the delivery branch. */
export async function assertIntegratedCheckout(
  run: CommandRunner,
  input: Readonly<{ readonly cwd: string; readonly branch: string; readonly head: string }>,
): Promise<DeliveryCheckout> {
  const checkout = await deliveryCheckout(run, input.cwd, input.branch);
  if (checkout.head !== input.head) {
    throw new Error(
      `delivery worktree HEAD ${JSON.stringify(checkout.head)} does not match the integrated HEAD ${JSON.stringify(input.head)}`,
    );
  }
  return checkout;
}
