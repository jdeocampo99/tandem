import { isAbsolute } from "node:path";
import {
  MAX_SKILL_NAME_CHARS,
  MAX_TASK_SKILLS_BYTES,
  SKILL_ORIGINS,
  type SkillInvocation,
} from "../contracts.ts";

/** Validated skills, or the exact defect that made the candidate unusable. */
export type SkillInvocationsCheck =
  | Readonly<{ readonly valid: true; readonly skills: readonly SkillInvocation[] }>
  | Readonly<{ readonly valid: false; readonly defect: string }>;

const FOUND_SKILL_KEYS = ["name", "origin", "directory", "instructions"] as const;
const SUMMARY_SKILL_KEYS = ["name", "origin", "instructions"] as const;
const LEGACY_SKILL_KEYS = ["name", "context"] as const;

/** Validate a task's skills without throwing, so each caller raises its own error type. */
export function checkSkillInvocations(value: unknown): SkillInvocationsCheck {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, defect: "skills must be a non-empty array" };
  }
  const skills: SkillInvocation[] = [];
  for (const [index, entry] of value.entries()) {
    const check = checkSkillInvocation(entry);
    if (typeof check === "string") return { valid: false, defect: `skills[${index}] ${check}` };
    if (skills.some((skill) => skill.name === check.name)) {
      return { valid: false, defect: `skill ${check.name} is listed more than once` };
    }
    skills.push(check);
  }
  const bytes = skillInstructionBytes(skills);
  if (bytes > MAX_TASK_SKILLS_BYTES) {
    return {
      valid: false,
      defect: `skill instructions total ${bytes} UTF-8 bytes, over the ${MAX_TASK_SKILLS_BYTES}-byte limit`,
    };
  }
  return { valid: true, skills };
}

/**
 * Reads the single `skill` a task recorded before Tandem looked skills up itself: a name plus the
 * coordinator's own summary, kept as a summary-origin skill.
 */
export function checkLegacySkillInvocation(value: unknown): SkillInvocationsCheck {
  if (!isPlainObject(value)) return { valid: false, defect: "skill must be an object" };
  const unexpected = unexpectedKey(value, LEGACY_SKILL_KEYS);
  if (unexpected !== undefined)
    return { valid: false, defect: `unexpected skill field ${unexpected}` };
  if (!isSingleLineText(value.name, MAX_SKILL_NAME_CHARS)) {
    return { valid: false, defect: nameDefect() };
  }
  if (!isNonEmptyText(value.context)) {
    return { valid: false, defect: "skill context must be non-empty text" };
  }
  return {
    valid: true,
    skills: [{ name: value.name, origin: "summary", instructions: value.context }],
  };
}

export function skillInstructionBytes(skills: readonly SkillInvocation[]): number {
  return skills.reduce((total, skill) => total + Buffer.byteLength(skill.instructions, "utf8"), 0);
}

/** One skill, or the defect that makes it unusable. */
function checkSkillInvocation(value: unknown): SkillInvocation | string {
  if (!isPlainObject(value)) return "must be an object";
  const origin = value.origin;
  if (typeof origin !== "string" || !SKILL_ORIGINS.some((allowed) => allowed === origin)) {
    return `origin must be one of ${SKILL_ORIGINS.join(", ")}`;
  }
  const unexpected = unexpectedKey(
    value,
    origin === "summary" ? SUMMARY_SKILL_KEYS : FOUND_SKILL_KEYS,
  );
  if (unexpected !== undefined) return `has unexpected field ${unexpected}`;
  if (!isSingleLineText(value.name, MAX_SKILL_NAME_CHARS)) return nameDefect();
  if (!isNonEmptyText(value.instructions)) return "instructions must be non-empty text";
  if (origin === "summary") {
    return { name: value.name, origin, instructions: value.instructions };
  }
  if (
    !isSingleLineText(value.directory, Number.POSITIVE_INFINITY) ||
    !isAbsolute(value.directory)
  ) {
    return "directory must be an absolute single-line path";
  }
  return {
    name: value.name,
    origin: origin === "repository" ? "repository" : "personal",
    directory: value.directory,
    instructions: value.instructions,
  };
}

function nameDefect(): string {
  return `name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedKey(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSingleLineText(value: unknown, maxChars: number): value is string {
  return isNonEmptyText(value) && value.length <= maxChars && !/[\r\n\u2028\u2029]/u.test(value);
}
