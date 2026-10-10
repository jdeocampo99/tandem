import type { MergingChoice } from "../config/repository-settings.ts";
import type { CommandRunner } from "../contracts.ts";
import {
  type BranchRules,
  hasAviatorConfig,
  originRepository,
  type RepositoryRead,
  readBranchRules,
  readRepository,
} from "./github.ts";

/**
 * What Tandem can tell about merging in one repository before PR watch merges anything there,
 * read-only: shown by `onboard --json` and asked about the first time a pull request is watched.
 */
export type MergingCheck =
  | Readonly<{
      readonly repo: string;
      readonly readable: false;
      /** A plain sentence for the user, naming what to do. */
      readonly message: string;
    }>
  | Readonly<{
      readonly repo: string;
      readonly readable: true;
      readonly branch: string;
      /** How it merges: through Aviator's labels, GitHub auto-merge, or unknown (ask for a label). */
      readonly method: "aviator" | "auto-merge" | "unknown";
      /** What "Turn on" saves; absent when the user has to name the queue label. */
      readonly proposal?: MergingChoice;
      readonly requiredChecks: BranchRules["requiredChecks"];
      readonly dismissesApprovals: BranchRules["dismissesApprovals"];
      readonly warnings: readonly string[];
      /** The one question to ask, with its choices. */
      readonly question: string;
    }>;

const AVIATOR_CHOICE: MergingChoice = {
  mergeWith: "queue-label",
  queueLabel: "mergequeue",
  blockedLabel: "blocked",
};

/** The check for the GitHub repository a Tandem project's origin names. */
export async function checkProjectMerging(
  run: CommandRunner,
  repoPath: string,
  cwd: string,
): Promise<MergingCheck> {
  const repo = await originRepository(run, repoPath);
  if (repo === undefined) {
    return {
      repo: "",
      readable: false,
      message:
        "This project's origin is not a GitHub repository, so PR watch has nothing to merge.",
    };
  }
  return checkMerging(run, repo, cwd);
}

/** Reads the repository, its Aviator config, and its base branch's rules, then describes them. */
export async function checkMerging(
  run: CommandRunner,
  repo: string,
  cwd: string,
): Promise<MergingCheck> {
  const repository = await readRepository(run, repo, cwd);
  if (!repository.readable) return describeMerging(repo, repository, false, undefined);
  const aviator = await hasAviatorConfig(run, repo, cwd);
  const rules = await readBranchRules(run, repo, repository.defaultBranch, cwd);
  return describeMerging(repo, repository, aviator, rules);
}

/** The check's answer from what GitHub said; separate from the reads so it can be tested alone. */
function describeMerging(
  repo: string,
  repository: RepositoryRead,
  aviator: boolean,
  rules: BranchRules | undefined,
): MergingCheck {
  if (!repository.readable || rules === undefined) {
    const reason = repository.readable ? "" : ` (${repository.reason})`;
    return {
      repo,
      readable: false,
      message: `GitHub won't show ${repo} to your gh login${reason}. Run gh auth login, or authorize the login for the organization's SSO, then try again.`,
    };
  }
  const method = aviator
    ? "aviator"
    : repository.allowAutoMerge === true
      ? "auto-merge"
      : "unknown";
  const warnings = [
    ...(rules.requiredChecks === "none"
      ? [
          `${repository.defaultBranch} requires no checks, so a pull request can merge before its CI finishes.`,
        ]
      : []),
    ...(rules.dismissesApprovals === "yes"
      ? [
          "A push here dismisses approvals, so each CI retry would cost a pull request its approvals.",
        ]
      : []),
  ];
  const offer = "Tandem can put your pull requests up for merging and retry flaky CI.";
  const question =
    method === "aviator"
      ? `This repo merges through Aviator. ${offer} Turn on, or Not now?`
      : method === "auto-merge"
        ? `This repo allows GitHub auto-merge. ${offer} Turn on, or Not now?`
        : "Which label queues a pull request here, or should Tandem use GitHub auto-merge once you turn it on in the repo's settings? Or Not now.";
  return {
    repo,
    readable: true,
    branch: repository.defaultBranch,
    method,
    ...(method === "aviator"
      ? { proposal: AVIATOR_CHOICE }
      : method === "auto-merge"
        ? { proposal: { mergeWith: "auto-merge" } }
        : {}),
    requiredChecks: rules.requiredChecks,
    dismissesApprovals: rules.dismissesApprovals,
    warnings,
    question,
  };
}
