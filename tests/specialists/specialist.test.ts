import { expect, test } from "bun:test";
import { BUILT_IN_SPECIALISTS, builtInSpecialist } from "../../src/specialists/built-in.ts";
import {
  checkSpecialist,
  MAX_SPECIALIST_BYTES,
  readSpecialistMarkdown,
  type SpecialistCheck,
} from "../../src/specialists/specialist.ts";

const source = { origin: "repository", path: "/repo/.tandem/specialists/blog-writer.md" } as const;

function read(text: string): SpecialistCheck {
  return readSpecialistMarkdown(text, source);
}

function defectLine(check: SpecialistCheck): number | undefined {
  if (check.valid) return undefined;
  const match = /^line (\d+):/u.exec(check.defect);
  return match === null ? undefined : Number(match[1]);
}

test("reads frontmatter, instructions, and the steps list; text after steps stays instructions", () => {
  const check = read(
    [
      "---",
      "# who writes the blog",
      "name: blog-writer",
      'label: "Blog writer"',
      "description: Writes posts for the docs blog. # used for guessing",
      "---",
      "You write posts.",
      "",
      "## Steps",
      "- Read the brief",
      "2. Write an outline",
      "",
      "## Voice",
      "Friendly.",
    ].join("\n"),
  );
  if (!check.valid) throw new Error(check.defect);
  expect(check.specialist).toMatchObject({
    origin: "repository",
    name: "blog-writer",
    label: "Blog writer",
    description: "Writes posts for the docs blog.",
    steps: ["Read the brief", "Write an outline"],
  });
  expect(check.specialist.instructions).toContain("You write posts.");
  expect(check.specialist.instructions).toContain("Friendly.");
  expect(check.specialist.instructions).not.toContain("Read the brief");
});

test("a steps heading inside a fenced code block is instructions, not steps", () => {
  const check = read("---\nname: a\n---\n```md\n## Steps\n- not a step\n```\n## Steps\n- real");
  if (!check.valid) throw new Error(check.defect);
  expect(check.specialist.steps).toEqual(["real"]);
});

test("label defaults to the name; a file with only steps is valid", () => {
  const check = read("---\nname: blog-writer\n---\n## Steps\n- Write it\n");
  if (!check.valid) throw new Error(check.defect);
  expect(check.specialist.label).toBe("blog-writer");
  expect(check.specialist.instructions).toBe("");
});

test("each file defect is refused at the line that causes it", () => {
  expect(defectLine(read("---\nname: a\nmodel: opus\n---\nBody"))).toBe(3);
  expect(defectLine(read("---\nname: a\nname: b\n---\nBody"))).toBe(3);
  expect(defectLine(read("---\nname: a\n---\n## Steps\n- one\n- one"))).toBe(6);
  expect(defectLine(read("---\nname: a\n---\n## Steps\n- one\n## steps\n- two"))).toBe(6);
  expect(defectLine(read("---\nname: a\n---\n## Steps\nnot a list item"))).toBe(5);
  expect(defectLine(read("---\nname: a\nlabel: 'open\n---\nBody"))).toBe(3);
  expect(defectLine(read(`---\nname: a\nlabel: ${"x".repeat(61)}\n---\nBody`))).toBe(3);
  expect(read("---\nname: a\n---\n").valid).toBe(false);
  expect(read("---\nname: Bad_Name\n---\nBody").valid).toBe(false);
  expect(read("name: a\nBody").valid).toBe(false);
  expect(read("---\nname: a\nBody").valid).toBe(false);
  expect(read(`---\nname: a\n---\n${"x".repeat(MAX_SPECIALIST_BYTES + 1)}`).valid).toBe(false);
});

test("a stored snapshot round-trips, and any edit to its content breaks the digest", () => {
  const check = read("---\nname: a\ndescription: d\n---\nDo it.\n## Steps\n- one");
  if (!check.valid) throw new Error(check.defect);
  const stored: unknown = JSON.parse(JSON.stringify(check.specialist));
  expect(checkSpecialist(stored)).toEqual({ valid: true, specialist: check.specialist });
  expect(checkSpecialist({ ...check.specialist, steps: ["two"] }).valid).toBe(false);
  expect(checkSpecialist({ ...check.specialist, instructions: "Do less." }).valid).toBe(false);
  expect(checkSpecialist({ ...check.specialist, origin: "home" }).valid).toBe(false);
  expect(checkSpecialist({ ...check.specialist, extra: true }).valid).toBe(false);
  expect(checkSpecialist({ ...check.specialist, path: "relative.md" }).valid).toBe(false);
});

test("built-ins are valid stored snapshots and can be looked up by their old playbook ids", () => {
  for (const specialist of BUILT_IN_SPECIALISTS) {
    expect(checkSpecialist(specialist)).toEqual({ valid: true, specialist });
  }
  expect(builtInSpecialist("perf")?.steps).toEqual([
    "Measure a baseline",
    "Find the cause",
    "Fix the cause",
    "Measure again",
  ]);
  expect(builtInSpecialist("fix-round")).toBeUndefined();
  expect(builtInSpecialist("general")?.steps).toEqual(builtInSpecialist("feature")?.steps.slice(1));
});
