import {
  MAX_SKILL_CONTEXT_BYTES,
  MAX_SKILL_NAME_CHARS,
  type SkillInvocation,
} from "../contracts.ts";

/** A validated skill invocation, or the exact defect that made the candidate unusable. */
export type SkillInvocationCheck =
  | Readonly<{ readonly valid: true; readonly invocation: SkillInvocation }>
  | Readonly<{ readonly valid: false; readonly defect: string }>;

const SKILL_INVOCATION_KEYS = ["name", "context"] as const;
const LINE_SEPARATOR_CODE = 0x2028;
const PARAGRAPH_SEPARATOR_CODE = 0x2029;

function hasLineBreak(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x0a ||
      code === 0x0d ||
      code === LINE_SEPARATOR_CODE ||
      code === PARAGRAPH_SEPARATOR_CODE
    ) {
      return true;
    }
  }
  return false;
}

function isSingleLineText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !hasLineBreak(value)
  );
}

/** Validate a candidate skill invocation without throwing, so each caller raises its own error type. */
export function checkSkillInvocation(value: unknown): SkillInvocationCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, defect: "skill invocation must be an object" };
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find(
    (key) => !SKILL_INVOCATION_KEYS.some((allowed) => allowed === key),
  );
  if (unexpected !== undefined) {
    return { valid: false, defect: `unexpected skill invocation field ${unexpected}` };
  }
  if (!isSingleLineText(record.name, MAX_SKILL_NAME_CHARS)) {
    return {
      valid: false,
      defect: `skill invocation name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`,
    };
  }
  if (typeof record.context !== "string" || record.context.trim().length === 0) {
    return { valid: false, defect: "skill invocation context must be non-empty text" };
  }
  if (Buffer.byteLength(record.context, "utf8") > MAX_SKILL_CONTEXT_BYTES) {
    return {
      valid: false,
      defect: `skill invocation context exceeds ${MAX_SKILL_CONTEXT_BYTES} UTF-8 bytes`,
    };
  }
  return {
    valid: true,
    invocation: { name: record.name, context: record.context },
  };
}
