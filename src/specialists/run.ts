import type { Specialist } from "./specialist.ts";

/** Code-owned; never a specialist, never listed, never replaceable. */
const FIX_ROUND_STEPS = [
  "Fix each P0 and P1 finding, or decline it in your report if it has no realistic failure or is out of scope; leave P2 and P3 as known issues",
  "Confirm each finding is gone",
  "Question the first fix's assumption for any repeat finding",
] as const;

export type SpecialistRun = Readonly<{
  /** Whose instructions apply; absent on tasks created before playbooks existed. */
  readonly specialist?: Specialist;
  readonly checklist: "specialist" | "fix-round";
  /** What the submit gate holds the implementer to. */
  readonly steps: readonly string[];
}>;

/** Every fix round follows the fix-round steps, still under the pinned specialist's instructions. */
export function specialistForRun(
  pinned: Specialist | undefined,
  fixRound: boolean,
): SpecialistRun | undefined {
  if (fixRound) {
    return { ...(pinned === undefined ? {} : { specialist: pinned }), checklist: "fix-round", steps: FIX_ROUND_STEPS };
  }
  return pinned === undefined
    ? undefined
    : { specialist: pinned, checklist: "specialist", steps: pinned.steps };
}

/** The implementer brief section: `## Specialist: <label>`, its instructions, then `### Steps` or `### Fix round steps`. */
export function specialistSection(run: SpecialistRun): string {
  const lines = [
    run.specialist === undefined ? "## Fix round" : `## Specialist: ${run.specialist.label}`,
  ];
  const instructions = run.specialist?.instructions ?? "";
  if (instructions.length > 0) lines.push(instructions);
  if (run.steps.length > 0) {
    lines.push(
      run.checklist === "fix-round" ? "### Fix round steps" : "### Steps",
      "Start by loading these steps into your to-do list with the todo tool, word for word, as one phase named Steps. Add your own steps in other phases. Mark each step done as you finish it.",
      "If a step does not apply, drop it (mark it abandoned) and give the reason in your report. A report with any step still open is rejected.",
      ...run.steps.map((step, index) => `${index + 1}. ${step}`),
    );
  }
  return lines.join("\n");
}
