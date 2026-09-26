import { basename } from "node:path";
import {
  choiceConfidence,
  evaluateJev,
  JEV_MODEL,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevGateway,
  type JevQuestions,
} from "../adapters/typesafe.ts";
import type { TaskRecord } from "../contracts.ts";

/** The repository Tandem's own issues and fixes go to. */
export const TANDEM_REPOSITORY = "jdeocampo99/tandem";

export type IssueDraft = Readonly<{ readonly title: string; readonly body: string }>;

/** What a draft about one task must not carry: that task's words and its repositories' names. */
export type WorkContent = Readonly<{
  readonly phrases: readonly string[];
  readonly names: readonly string[];
}>;

/** Whether the draft may still hold work content. Anything but a confident "clean" is flagged. */
export type DraftCheck =
  | Readonly<{ readonly flagged: false }>
  | Readonly<{ readonly flagged: true; readonly warning: string }>;

export type IssueDraftChecker = (draft: IssueDraft) => Promise<DraftCheck>;

export type IssueDraftCheckConfig = Readonly<{
  readonly apiKey?: string;
  readonly gateway?: JevGateway;
  readonly timeoutMs: number;
  readonly fetch?: JevFetch;
}>;

export type IssueDraftEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

const CLEAN_CONFIDENCE = 0.8;
/** Longer drafts are not sent; an unchecked tail could hold anything. */
const MAX_CHECKED_CHARS = 12_000;
/** Shorter task text is too likely to match ordinary words in the diagnosis. */
const MIN_PHRASE_CHARS = 20;
const MIN_NAME_CHARS = 3;

const CODE_BLOCK = /```[\s\S]*?(?:```|$)/gu;
/** A path with at least two parts starting at `/` or `~`, but not the path part of a URL. */
const LOCAL_PATH = /(?<![\w.:/~-])(?:~|\/[\w.@-]+)(?:\/[^\s)"'`\]>,;]+)+/gu;
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/gu;

const QUESTIONS: JevQuestions = {
  leak: {
    type: "choice",
    instructions:
      "This is a draft GitHub issue for Tandem, a public developer tool. It describes a problem Tandem had while working in someone's private work repository. Decide whether the draft still contains anything from that work repository or anything secret.",
    criteria: {
      clean:
        "It describes only Tandem's own behavior, source, and settings. It has no file paths, code, project names, task descriptions, or business details from the work repository, and no secrets.",
      flagged:
        "It still contains file paths, code, project names, task descriptions, or business details from the work repository, or a secret such as a key, token, or password.",
    },
  },
};

/** The task's own text and the names of the repositories it worked in. */
export function workContentOf(task: TaskRecord): WorkContent {
  const phrases = [
    task.objective,
    ...task.acceptanceCriteria,
    ...(task.manualVerification ?? []),
    ...(task.blockReason === undefined ? [] : [task.blockReason]),
  ].flatMap((text) => text.split(/(?<=[.!?])\s+|\n+/u));
  const names = [basename(task.repoPath)];
  if (task.target !== undefined && task.target.repo !== TANDEM_REPOSITORY) {
    names.push(task.target.repo, basename(task.target.repo), basename(task.target.checkout));
  }
  const tandemName = basename(TANDEM_REPOSITORY);
  return {
    phrases: phrases.map((phrase) => phrase.trim()).filter((p) => p.length >= MIN_PHRASE_CHARS),
    names: names.filter((name) => name.length >= MIN_NAME_CHARS && name !== tandemName),
  };
}

/**
 * Removes what can be found without judgement: code blocks, local paths, token-shaped secrets, and
 * the task's own words and repository names. The Jev check is the backstop for the rest.
 */
export function scrubIssueDraft(draft: IssueDraft, work: WorkContent): IssueDraft {
  return { title: scrubText(draft.title, work), body: scrubText(draft.body, work) };
}

/** One Jev call over the scrubbed draft. A missing key, failure, or timeout counts as flagged. */
export async function checkIssueDraft(
  draft: IssueDraft,
  config: IssueDraftCheckConfig,
  evaluate: IssueDraftEvaluator = evaluateJev,
): Promise<DraftCheck> {
  if (config.apiKey === undefined) {
    return flagged("It wasn't checked for work details, because Jev isn't set up here.");
  }
  if (draft.title.length + draft.body.length > MAX_CHECKED_CHARS) {
    return flagged("It's too long to check for work details.");
  }
  let response: JevEvaluationResponse;
  try {
    response = await evaluate(
      { model: JEV_MODEL, state: { title: draft.title, body: draft.body }, questions: QUESTIONS },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      },
    );
  } catch {
    return flagged("The check for work details didn't finish.");
  }
  const answer = response.answers.leak;
  const confidence = answer?.type === "choice" ? choiceConfidence(answer) : undefined;
  if (
    answer?.type === "choice" &&
    answer.choice === "clean" &&
    (confidence ?? 0) >= CLEAN_CONFIDENCE
  ) {
    return { flagged: false };
  }
  return flagged("It may still contain work code, paths, or secrets.");
}

export function issueDraftChecker(
  config: IssueDraftCheckConfig,
  evaluate: IssueDraftEvaluator = evaluateJev,
): IssueDraftChecker {
  return (draft) => checkIssueDraft(draft, config, evaluate);
}

function scrubText(text: string, work: WorkContent): string {
  let scrubbed = text
    .replace(CODE_BLOCK, "(code removed)")
    // Sentence punctuation after a path stays in the sentence.
    .replace(LOCAL_PATH, (path) => `(path removed)${/[.:!?]+$/u.exec(path)?.[0] ?? ""}`)
    .replace(SECRET, "(secret removed)");
  for (const phrase of work.phrases) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(phrase), "giu"), "(task text removed)");
  }
  for (const name of work.names) {
    scrubbed = scrubbed.replace(
      new RegExp(`(?<![\\w/.-])${escapeRegExp(name)}(?![\\w/-])`, "giu"),
      "(project name removed)",
    );
  }
  return scrubbed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function flagged(warning: string): DraftCheck {
  return { flagged: true, warning };
}
