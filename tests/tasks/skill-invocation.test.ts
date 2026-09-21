import { expect, test } from "bun:test";
import { MAX_SKILL_CONTEXT_BYTES, MAX_SKILL_NAME_CHARS } from "../../src/contracts.ts";
import { checkSkillInvocation } from "../../src/tasks/skill-invocation.ts";

test("accepts a well-formed skill invocation", () => {
  const check = checkSkillInvocation({ name: "refactor-functions", context: "Refactor foo.ts" });
  expect(check).toEqual({
    valid: true,
    invocation: { name: "refactor-functions", context: "Refactor foo.ts" },
  });
});

test("rejects a non-object, an unexpected field, and a multiline or oversized name", () => {
  expect(checkSkillInvocation("refactor-functions")).toEqual({
    valid: false,
    defect: "skill invocation must be an object",
  });
  expect(checkSkillInvocation(null)).toEqual({
    valid: false,
    defect: "skill invocation must be an object",
  });
  expect(
    checkSkillInvocation({ name: "refactor-functions", context: "context", extra: "field" }),
  ).toEqual({
    valid: false,
    defect: "unexpected skill invocation field extra",
  });
  expect(checkSkillInvocation({ name: "line-one\nline-two", context: "context" })).toEqual({
    valid: false,
    defect: `skill invocation name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`,
  });
  expect(
    checkSkillInvocation({ name: "x".repeat(MAX_SKILL_NAME_CHARS + 1), context: "context" }),
  ).toEqual({
    valid: false,
    defect: `skill invocation name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`,
  });
  expect(checkSkillInvocation({ name: "", context: "context" })).toEqual({
    valid: false,
    defect: `skill invocation name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`,
  });
});

test("rejects an empty or oversized context", () => {
  expect(checkSkillInvocation({ name: "refactor-functions", context: "" })).toEqual({
    valid: false,
    defect: "skill invocation context must be non-empty text",
  });
  expect(
    checkSkillInvocation({
      name: "refactor-functions",
      context: "x".repeat(MAX_SKILL_CONTEXT_BYTES + 1),
    }),
  ).toEqual({
    valid: false,
    defect: `skill invocation context exceeds ${MAX_SKILL_CONTEXT_BYTES} UTF-8 bytes`,
  });
});

test("accepts a context exactly at the byte budget, including multibyte characters", () => {
  const multibyteContext = `${"界".repeat(Math.floor(MAX_SKILL_CONTEXT_BYTES / 3))}x`;
  expect(Buffer.byteLength(multibyteContext, "utf8")).toBe(MAX_SKILL_CONTEXT_BYTES);
  const check = checkSkillInvocation({ name: "refactor-functions", context: multibyteContext });
  expect(check.valid).toBe(true);
});
