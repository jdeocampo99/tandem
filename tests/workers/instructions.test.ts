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
