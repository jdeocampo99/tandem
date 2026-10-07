import { expect, test } from "bun:test";
import {
  MAX_SPECIALIST_BYTES,
  readSpecialistMarkdown,
  type SpecialistFields,
  specialistFields,
  specialistMarkdown,
} from "../../src/specialists/specialist.ts";

function roundTrip(name: string, fields: SpecialistFields): SpecialistFields {
  const written = specialistMarkdown(name, fields);
  if (!written.ok) throw new Error(written.problem);
  const read = readSpecialistMarkdown(written.text, { origin: "home", path: `/home/${name}.md` });
  if (!read.valid) throw new Error(read.defect);
  expect(read.specialist.name).toBe(name);
  return specialistFields(read.specialist);
}

test.each<[string, SpecialistFields]>([
  [
    "every field",
    {
      label: "SEO blog post",
      description: "A blog post that has to rank for a keyword",
      instructions:
        "Write for a reader who searched.\n\n- Lead with the answer\n\n```md\n## Steps\n```",
      steps: ["Pick the keyword", "Draft", "Check headings"],
    },
  ],
  [
    "instructions only, used only when named",
    { label: "Notes", instructions: "Short.", steps: [] },
  ],
  ["steps only", { label: "Checklist", instructions: "", steps: ["One", "Two"] }],
  [
    "values the frontmatter must quote",
    {
      label: '"Quoted" C #1',
      description: "It's for # tags and ' marks",
      instructions: "# A heading\nBody",
      steps: ["- a dash", "1. a number"],
    },
  ],
])("%s reads back as the same fields", (_, fields) => {
  expect(roundTrip("seo-blog", fields)).toEqual(fields);
});

test("fields are trimmed and a blank description means only when named", () => {
  expect(
    roundTrip("notes", {
      label: "  Notes ",
      description: "   ",
      instructions: "\r\nLine one\r\nLine two\n\n",
      steps: [" Step "],
    }),
  ).toEqual({ label: "Notes", instructions: "Line one\nLine two", steps: ["Step"] });
});

test.each<[string, string, SpecialistFields, string]>([
  ["a bad name", "SEO", { label: "x", instructions: "y", steps: [] }, "not a specialist name"],
  ["an empty label", "a", { label: " ", instructions: "y", steps: [] }, "label is empty"],
  ["no content", "a", { label: "x", instructions: " ", steps: [] }, "instructions, steps"],
  ["a repeated step", "a", { label: "x", instructions: "", steps: ["s", "s"] }, "appears twice"],
  ["an empty step", "a", { label: "x", instructions: "", steps: ["s", " "] }, "non-empty"],
  [
    "both quote kinds and a comment marker",
    "a",
    { label: `"it's" #1`, instructions: "y", steps: [] },
    "can't hold both quote kinds",
  ],
  [
    "a Steps heading inside the instructions",
    "a",
    { label: "x", instructions: "Intro\n## Steps\n- hidden", steps: ["shown"] },
    "at most one ## Steps section",
  ],
  [
    "an unclosed code fence",
    "a",
    { label: "x", instructions: "```\ncode", steps: ["shown"] },
    "would not read back",
  ],
  [
    "a file over the loader's cap",
    "a",
    { label: "x", instructions: "y".repeat(MAX_SPECIALIST_BYTES - 10), steps: [] },
    "a specialist file is at most",
  ],
])("refuses %s", (_, name, fields, problem) => {
  const written = specialistMarkdown(name, fields);
  expect(written.ok).toBe(false);
  if (!written.ok) expect(written.problem).toContain(problem);
});
