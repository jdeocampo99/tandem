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
import type { RequestBriefContent } from "../contracts.ts";

/** What the reader approves from, by the heading the brief shows it under. */
export type BriefTopSections = Readonly<Record<string, string>>;

/** One line per section that may not read plainly; empty when none were found. */
export type BriefLanguageChecker = (content: RequestBriefContent) => Promise<readonly string[]>;

export type BriefLanguageCheckConfig = Readonly<{
  readonly apiKey?: string;
  readonly gateway?: JevGateway;
  readonly timeoutMs: number;
  readonly fetch?: JevFetch;
}>;

export type BriefLanguageEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

/** Jev must be at least this sure before a section is called jargon, so a doubt never nags. */
const JARGON_CONFIDENCE = 0.7;

/** Writing tells exact enough to find without judgement; the coordinator's prose bans list them. */
const EXACT_TELLS: readonly (readonly [RegExp, string])[] = [
  [/—/u, "an em dash"],
  [/`[^`]+`/u, "code formatting"],
  [/(?:^|\s)[\w.~-]*\/[\w./-]+\.\w{1,5}\b/u, "a file path"],
  [/\b[a-z]+_[a-z0-9_]+\b/u, "a code name"],
  [
    /\b(?:delve|crucial|robust|seamless(?:ly)?|leverag(?:e|es|ing)|utiliz(?:e|es|ing)|comprehensive|notably|furthermore)\b/iu,
    "a filler word",
  ],
];

/** The top of the brief as the reader sees it; a brief saved before the summary has less. */
export function briefTopSections(content: RequestBriefContent): BriefTopSections {
  const sections: Record<string, string> = { "TL;DR": content.goal };
  const summary = content.summary;
  if (summary !== undefined) {
    sections.Title = summary.title;
    sections["Before and after"] = summary.beforeAfter
      .map((moment) => `${moment.moment}. Before: ${moment.before} After: ${moment.after}`)
      .join("\n");
    sections["Size and risk"] = `${summary.size.reason}\n${summary.risk.reason}`;
  }
  if (content.manualVerification.length > 0) {
    sections["How you'll verify"] = content.manualVerification.join("\n");
  }
  sections.Approach =
    typeof content.recommendedApproach === "string"
      ? content.recommendedApproach
      : content.recommendedApproach.join("\n");
  return sections;
}

/** The exact tells in each section, named with the text that tripped them. */
export function exactLanguageFindings(sections: BriefTopSections): readonly string[] {
  return Object.entries(sections).flatMap(([section, text]) =>
    EXACT_TELLS.flatMap(([pattern, tell]) => {
      const match = pattern.exec(text);
      return match === null ? [] : [`${section} has ${tell}: "${match[0].trim()}"`];
    }),
  );
}

/**
 * Exact tells first, then one Jev call judging each section for someone who uses the product but
 * never read its code. A missing key, failure, or timeout skips Jev: this check advises the
 * coordinator and never blocks a draft.
 */
export async function checkBriefLanguage(
  content: RequestBriefContent,
  config: BriefLanguageCheckConfig,
  evaluate: BriefLanguageEvaluator = evaluateJev,
): Promise<readonly string[]> {
  const sections = briefTopSections(content);
  const findings = [...exactLanguageFindings(sections)];
  if (config.apiKey === undefined) return findings;
  const names = Object.keys(sections);
  let response: JevEvaluationResponse;
  try {
    response = await evaluate(
      { model: JEV_MODEL, state: sections, questions: jargonQuestions(names) },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      },
    );
  } catch {
    return findings;
  }
  names.forEach((section, index) => {
    const answer = response.answers[questionKey(index)];
    if (answer?.type !== "choice" || answer.choice !== "jargon") return;
    if ((choiceConfidence(answer) ?? 0) < JARGON_CONFIDENCE) return;
    findings.push(`${section} may not read plainly to someone who never read the code`);
  });
  return findings;
}

export function briefLanguageChecker(
  config: BriefLanguageCheckConfig,
  evaluate: BriefLanguageEvaluator = evaluateJev,
): BriefLanguageChecker {
  return (content) => checkBriefLanguage(content, config, evaluate);
}

function jargonQuestions(sections: readonly string[]): JevQuestions {
  return Object.fromEntries(
    sections.map((section, index) => [
      questionKey(index),
      {
        type: "choice",
        instructions: `The state is the top of a plan a product owner reads before approving a change to their software. They use the product every day but have never read its code. Judge only the text under "${section}".`,
        criteria: {
          plain:
            "It describes what people see or do in the product, in everyday words the owner understands on first read.",
          jargon:
            "It relies on code names, internal mechanisms, library or API names, version numbers, or technical terms the owner would have to look up.",
        },
      },
    ]),
  );
}

function questionKey(index: number): string {
  return `section${index}`;
}
