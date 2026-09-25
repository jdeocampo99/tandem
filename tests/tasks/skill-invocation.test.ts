import { expect, test } from "bun:test";
import { MAX_SKILL_NAME_CHARS, MAX_TASK_SKILLS_BYTES } from "../../src/contracts.ts";
import {
  checkLegacySkillInvocation,
  checkSkillInvocations,
} from "../../src/tasks/skill-invocation.ts";

const tdd = {
  name: "tdd",
  origin: "personal",
  directory: "/Users/me/.claude/skills/tdd",
  instructions: "Write a failing test first.",
} as const;

test("accepts found and summary skills", () => {
  const summary = { name: "old", origin: "summary", instructions: "A summary." } as const;
  expect(checkSkillInvocations([tdd, summary])).toEqual({ valid: true, skills: [tdd, summary] });
});

test("rejects an empty list, a repeated name, a bad origin, and an unexpected field", () => {
  expect(checkSkillInvocations([])).toEqual({
    valid: false,
    defect: "skills must be a non-empty array",
  });
  expect(checkSkillInvocations([tdd, tdd])).toEqual({
    valid: false,
    defect: "skill tdd is listed more than once",
  });
  expect(checkSkillInvocations([{ ...tdd, origin: "global" }])).toEqual({
    valid: false,
    defect: "skills[0] origin must be one of repository, personal, summary",
  });
  expect(checkSkillInvocations([{ ...tdd, scope: "everything" }])).toEqual({
    valid: false,
    defect: "skills[0] has unexpected field scope",
  });
  expect(
    checkSkillInvocations([{ name: "old", origin: "summary", instructions: "x", directory: "/x" }]),
  ).toEqual({ valid: false, defect: "skills[0] has unexpected field directory" });
});

test("rejects a multiline or oversized name, empty instructions, and a relative folder", () => {
  const nameDefect = `skills[0] name must be single-line text of at most ${MAX_SKILL_NAME_CHARS} characters`;
  expect(checkSkillInvocations([{ ...tdd, name: "line\nbreak" }])).toEqual({
    valid: false,
    defect: nameDefect,
  });
  expect(checkSkillInvocations([{ ...tdd, name: "x".repeat(MAX_SKILL_NAME_CHARS + 1) }])).toEqual({
    valid: false,
    defect: nameDefect,
  });
  expect(checkSkillInvocations([{ ...tdd, instructions: " " }])).toEqual({
    valid: false,
    defect: "skills[0] instructions must be non-empty text",
  });
  expect(checkSkillInvocations([{ ...tdd, directory: "skills/tdd" }])).toEqual({
    valid: false,
    defect: "skills[0] directory must be an absolute single-line path",
  });
});

test("counts every skill's instructions against one byte limit", () => {
  const half = "界".repeat(Math.floor(MAX_TASK_SKILLS_BYTES / 6));
  expect(
    checkSkillInvocations([
      { ...tdd, instructions: half },
      { ...tdd, name: "other", instructions: half },
    ]).valid,
  ).toBe(true);
  const tooMuch = checkSkillInvocations([
    { ...tdd, instructions: half },
    { ...tdd, name: "other", instructions: `${half}xxxxx` },
  ]);
  expect(tooMuch.valid).toBe(false);
});

test("reads the single coordinator-written skill older tasks recorded as a summary", () => {
  expect(checkLegacySkillInvocation({ name: "refactor", context: "Refactor foo.ts" })).toEqual({
    valid: true,
    skills: [{ name: "refactor", origin: "summary", instructions: "Refactor foo.ts" }],
  });
  expect(checkLegacySkillInvocation({ name: "refactor", context: "" })).toEqual({
    valid: false,
    defect: "skill context must be non-empty text",
  });
  expect(checkLegacySkillInvocation({ name: "refactor", context: "x", extra: 1 })).toEqual({
    valid: false,
    defect: "unexpected skill field extra",
  });
});
