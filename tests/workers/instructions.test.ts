import { expect, test } from "bun:test";
import {
  buildAgentBrief,
  CODE_STANDARDS,
  IMPLEMENTER_PRINCIPLES,
  MANUAL_VERIFICATION_REVIEWER,
  MANUAL_VERIFICATION_WORKER,
  type PrDescriptionInput,
  REVIEWER_PRINCIPLES,
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

const skillBriefBase = {
  objective: "Refactor the parser",
  acceptanceCriteria: ["Keep behavior identical."],
  instructions: ["Follow the guidance channel."],
  reportPath: "/tmp/report.txt",
} as const;
const repositorySkill = {
  name: "refactor-functions",
  origin: "repository",
  directory: "/repo/.claude/skills/refactor-functions",
  instructions: "Apply the five function-review principles.",
} as const;
const personalSkill = {
  name: "tdd",
  origin: "personal",
  directory: "/Users/me/.claude/skills/tdd",
  instructions: "Write a failing test first.",
} as const;

test("gives a worker every skill in full with its folder, and keeps the brief in charge", () => {
  const brief = buildAgentBrief({
    ...skillBriefBase,
    role: "implementer",
    skills: [repositorySkill, personalSkill],
  });

  expect(brief).toContain("## Skills");
  expect(brief).toContain("Follow each one as part of the objective above.");
  expect(brief).toContain("### refactor-functions, from this repository");
  expect(brief).toContain("Folder: /repo/.claude/skills/refactor-functions");
  expect(brief).toContain("Apply the five function-review principles.");
  expect(brief).toContain("### tdd, from the user's personal skills");
  expect(brief).toContain("Folder: /Users/me/.claude/skills/tdd");
  expect(brief).toContain("Write a failing test first.");
  expect(brief).toContain("this brief wins");
  expect(brief).toContain("outcome needs-decision");
});

test("asks a reviewer to check the work against the skills, not to run them", () => {
  const brief = buildAgentBrief({ ...skillBriefBase, role: "reviewer", skills: [personalSkill] });

  expect(brief).toContain("Check that the change follows them.");
  expect(brief).toContain("Report a departure only when it changes behavior");
  expect(brief).toContain("stay read-only");
  expect(brief).toContain("Write a failing test first.");
  expect(brief).not.toContain("Follow each one as part of the objective above.");
});

test("labels an older task's skill as the coordinator's summary without a folder", () => {
  const brief = buildAgentBrief({
    ...skillBriefBase,
    role: "implementer",
    skills: [{ name: "refactor", origin: "summary", instructions: "Summary text." }],
  });

  expect(brief).toContain("### refactor, the coordinator's summary of it");
  expect(brief).not.toContain("Folder:");
});

test("omits the skills section entirely when no skill is supplied", () => {
  const brief = buildAgentBrief({ ...skillBriefBase, role: "reviewer" });

  expect(brief).not.toContain("## Skills");
});

test("rejects a malformed skill input", () => {
  expect(() =>
    buildAgentBrief({
      ...skillBriefBase,
      role: "implementer",
      skills: [{ ...personalSkill, name: "" }],
    }),
  ).toThrow(TypeError);
  expect(() =>
    buildAgentBrief({
      ...skillBriefBase,
      role: "implementer",
      skills: [{ ...personalSkill, instructions: "" }],
    }),
  ).toThrow(TypeError);
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

test("the reviewer brief tells the worker a listed user decision settles its question", () => {
  const base = {
    objective: "Ship the streak feature",
    acceptanceCriteria: ["Streak bar glows at 5 in a row"],
    instructions: [],
    reportPath: "/tmp/report.txt",
  };

  const brief = buildAgentBrief({ ...base, role: "reviewer" });
  expect(brief).toContain("A user decision listed in the review brief settles its question");
  expect(brief).toContain("do not fail the lens for missing runner evidence on it");
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

test("gives implementers the same code standards the reviewer grades against", () => {
  const input = {
    objective: "Change the parser",
    acceptanceCriteria: ["Keep behavior identical."],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
  };

  expect(buildAgentBrief({ ...input, role: "implementer" })).toContain(CODE_STANDARDS);
  expect(
    buildAgentBrief({
      ...input,
      role: "reviewer",
      review: { head: "abc123", pass: "review" },
    }),
  ).toContain(CODE_STANDARDS);
  expect(buildAgentBrief({ ...input, role: "scout" })).not.toContain(CODE_STANDARDS);
});

test("implementers follow the principle rules and reviewers grade the same rules as blocking", () => {
  const input = {
    objective: "Change the parser",
    acceptanceCriteria: ["Keep behavior identical."],
    instructions: ["Follow the guidance channel."],
    reportPath: "/tmp/report.txt",
  };
  const rule = "- Dead code in a file you're adding to: delete it first.";

  const implementer = buildAgentBrief({ ...input, role: "implementer" });
  expect(implementer).toContain(IMPLEMENTER_PRINCIPLES);
  expect(implementer).toContain(rule);
  const reviewer = buildAgentBrief({
    ...input,
    role: "reviewer",
    review: { head: "abc123", pass: "review" },
  });
  expect(reviewer).toContain(REVIEWER_PRINCIPLES);
  expect(reviewer).toContain(rule);
  expect(reviewer).toContain("P1 finding that names the rule");
  expect(buildAgentBrief({ ...input, role: "scout" })).not.toContain(rule);
});

test("each worker brief states the report rules once and leaves out coordinator-only rules", () => {
  const input = {
    objective: "Change the parser",
    acceptanceCriteria: ["Keep behavior identical."],
    instructions: [],
    reportPath: "/tmp/report.txt",
  };
  for (const role of ["scout", "implementer", "reviewer", "presentation"] as const) {
    const brief = buildAgentBrief({ ...input, role });
    expect(brief.split("Deliver the final report only by calling submit_report")).toHaveLength(2);
    expect(brief.split("one single-line question")).toHaveLength(2);
    expect(brief).not.toContain("state.sqlite");
    expect(brief).not.toContain("tandem reset");
    expect(brief).not.toContain("## Instructions");
  }
  expect(() =>
    buildAgentBrief({ ...input, role: "coordinator" } as unknown as Parameters<
      typeof buildAgentBrief
    >[0]),
  ).toThrow(TypeError);
});

test("a reviewer reports findings only; Tandem supplies the lens, generation, and verdict", () => {
  const brief = buildAgentBrief({
    role: "reviewer",
    objective: "Review the change",
    acceptanceCriteria: ["Confirm behavior."],
    instructions: [],
    reportPath: "/tmp/report.txt",
    review: { head: "abc123", pass: "review" },
  });

  expect(brief).toContain("## Commit under review\nabc123");
  expect(brief).toContain("Tandem records the commit and whether the review passes.");
  expect(brief).not.toContain('"lens"');
  expect(brief).not.toContain('"generation"');
  expect(brief).not.toContain('"pass"');
});

test("manual verification becomes an unticked checklist after validation", () => {
  const rendered = renderPrDescription({
    ...validDescription,
    manualVerification: ["The streak bar glows at 5 in a row", "Both flashcard modes show the bar"],
  });

  expect(
    rendered.endsWith(
      [
        "# Validation",
        "- Targeted formatter scenarios are covered by this test.",
        "",
        "# Manual verification",
        "Check these by hand before merging.",
        "- [ ] The streak bar glows at 5 in a row",
        "- [ ] Both flashcard modes show the bar",
      ].join("\n"),
    ),
  ).toBe(true);
  expect(renderPrDescription({ ...validDescription, manualVerification: [] })).toBe(
    renderPrDescription(validDescription),
  );
});

test("reviewers are told to leave manual verification alone; implementers may try it", () => {
  const input = {
    objective: "Show a streak bar.",
    acceptanceCriteria: ["Streak logic has unit tests"],
    manualVerification: ["The streak bar glows at 5 in a row"],
    instructions: [],
    reportPath: "/tmp/report.md",
  };

  const reviewer = buildAgentBrief({ ...input, role: "reviewer" });
  const implementer = buildAgentBrief({ ...input, role: "implementer" });

  expect(reviewer).toContain("## Automated checks\n- Streak logic has unit tests\n");
  expect(reviewer).toContain(
    `## Manual verification\n${MANUAL_VERIFICATION_REVIEWER}\n- The streak bar glows at 5 in a row\n`,
  );
  expect(implementer).toContain(
    `## Manual verification\n${MANUAL_VERIFICATION_WORKER}\n- The streak bar glows at 5 in a row\n`,
  );
  expect(buildAgentBrief({ ...input, manualVerification: [], role: "reviewer" })).not.toContain(
    "## Manual verification",
  );
});
