import { expect, test } from "bun:test";
import {
  buildAgentBrief,
  type PrDescriptionInput,
  renderPrDescription,
} from "../../src/instructions.ts";

const validDescription: PrDescriptionInput = {
  tldr: ["Adds durable review state.", "Keeps the pull request guidance concise."],
  what: ["Adds a pure formatter for reviewer-facing sections."],
  why: ["Reviewers need a stable, evidence-only description shape."],
  validation: ["Targeted formatter scenarios are covered by this test."],
};

test("renders the TLDR and the three required reviewer sections", () => {
  const rendered = renderPrDescription(validDescription);

  expect(rendered).toBe(
    [
      "TL;DR: Adds durable review state. Keeps the pull request guidance concise.",
      "",
      "# What",
      "- Adds a pure formatter for reviewer-facing sections.",
      "",
      "# Why",
      "- Reviewers need a stable, evidence-only description shape.",
      "",
      "# Validation",
      "- Targeted formatter scenarios are covered by this test.",
    ].join("\n"),
  );
});

test("retains accepted ordinary briefs and rejects oversized multibyte briefs", () => {
  const acceptedObjective = "界".repeat(18_000);
  const input = {
    role: "implementer" as const,
    objective: acceptedObjective,
    acceptanceCriteria: ["Keep all requirements."],
    instructions: ["Retain the final requirement marker."],
    reportPath: "/tmp/report.txt",
  };

  const brief = buildAgentBrief(input);
  expect(brief).toContain(acceptedObjective);
  expect(brief).toContain("Retain the final requirement marker.");

  const oversized = { ...input, objective: "界".repeat(22_000) };
  expect(() => buildAgentBrief(oversized)).toThrow(TypeError);
});

test("renders a skill section with its bounded context and a needs-decision reminder", () => {
  const brief = buildAgentBrief({
    role: "implementer",
    objective: "Refactor the parser",
    acceptanceCriteria: ["Keep behavior identical."],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
    skill: { name: "refactor-functions", context: "Apply the five function-review principles." },
  });

  expect(brief).toContain("## Skill");
  expect(brief).toContain("Requested skill: refactor-functions");
  expect(brief).toContain("Apply the five function-review principles.");
  expect(brief).toContain("do not load, infer, or run any other skill");
  expect(brief).toContain("never open a separate user conversation or channel");
});

test("omits the skill section entirely when no skill is supplied", () => {
  const brief = buildAgentBrief({
    role: "reviewer",
    objective: "Review the change",
    acceptanceCriteria: ["Confirm behavior."],
    instructions: ["Stay read-only."],
    reportPath: "/tmp/report.txt",
  });

  expect(brief).not.toContain("## Skill");
});

test("rejects a malformed skill input", () => {
  const base = {
    role: "implementer" as const,
    objective: "Refactor the parser",
    acceptanceCriteria: ["Keep behavior identical."],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
  };

  expect(() => buildAgentBrief({ ...base, skill: { name: "", context: "context" } })).toThrow(
    TypeError,
  );
  expect(() =>
    buildAgentBrief({ ...base, skill: { name: "refactor-functions", context: "" } }),
  ).toThrow(TypeError);
});

test("leaves the acceptance-criteria header unchanged when there are no you-check criteria", () => {
  const brief = buildAgentBrief({
    role: "implementer",
    objective: "Add a streak bar",
    acceptanceCriteria: ["Streak logic has unit tests"],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
  });

  expect(brief).toContain("## Acceptance criteria\n");
  expect(brief).not.toContain("Tandem checks");
  expect(brief).not.toContain("You check");
});

test("an implementer brief with you-check criteria splits the sections and names the evidence rule", () => {
  const brief = buildAgentBrief({
    role: "implementer",
    objective: "Add a streak bar",
    acceptanceCriteria: ["Streak logic has unit tests"],
    userCheckCriteria: ["Streak bar glows at 5 in a row"],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
  });

  expect(brief).toContain("## Acceptance criteria (Tandem checks)");
  expect(brief).toContain("- Streak logic has unit tests");
  expect(brief).toContain("## You check (the user judges these from screenshots)");
  expect(brief).toContain("- Streak bar glows at 5 in a row");
  expect(brief).toContain("userCheckEvidence");
  expect(brief).not.toContain("shown by the builder, not proof");
});

test("a reviewer brief with you-check criteria tells the lens they are not acceptance criteria", () => {
  const brief = buildAgentBrief({
    role: "reviewer",
    objective: "Review the streak bar change",
    acceptanceCriteria: ["Streak logic has unit tests"],
    userCheckCriteria: ["Streak bar glows at 5 in a row"],
    instructions: ["Stay read-only."],
    reportPath: "/tmp/report.txt",
  });

  expect(brief).toContain("## You check (the user judges these from screenshots)");
  expect(brief).toContain("shown by the builder, not proof");
  expect(brief).toContain("Do not fail a lens, raise a finding, or ask a needs-decision question");
});

test("a reviewer's ReviewResult schema and role instructions cover handToUser", () => {
  const brief = buildAgentBrief({
    role: "reviewer",
    objective: "Review the streak bar change",
    acceptanceCriteria: ["Streak logic has unit tests"],
    instructions: ["Stay read-only."],
    reportPath: "/tmp/report.txt",
    review: { head: "abc123", generation: 0, pass: "behavior" },
  });

  expect(brief).toContain('"handToUser"');
  expect(brief).toContain("Tandem hands it to the user");
});

test("rejects missing, empty, or overlong TLDR and section input", () => {
  const invalidInputs: readonly PrDescriptionInput[] = [
    { ...validDescription, tldr: [] },
    { ...validDescription, tldr: ["One.", "Two.", "Three.", "Four."] },
    { ...validDescription, what: [] },
    { ...validDescription, why: [] },
    { ...validDescription, validation: [] },
    { ...validDescription, what: undefined } as unknown as PrDescriptionInput,
  ];

  for (const input of invalidInputs) {
    expect(() => renderPrDescription(input)).toThrow(TypeError);
  }
});

test("rejects multiline entries and Markdown heading injection", () => {
  const invalidInputs: readonly PrDescriptionInput[] = [
    { ...validDescription, tldr: ["First sentence.\n# What"] },
    { ...validDescription, what: ["Changed behavior\r\n# Why"] },
    { ...validDescription, why: ["# Injected heading"] },
    { ...validDescription, validation: ["## Injected heading"] },
  ];

  for (const input of invalidInputs) {
    expect(() => renderPrDescription(input)).toThrow(TypeError);
  }
});
