import { expect, test } from "bun:test";
import { buildAgentBrief } from "../../src/instructions.ts";
import { builtInSpecialist } from "../../src/specialists/built-in.ts";
import { specialistForRun } from "../../src/specialists/run.ts";
import { readSpecialistMarkdown } from "../../src/specialists/specialist.ts";

const writer = (() => {
  const check = readSpecialistMarkdown(
    "---\nname: blog-writer\n---\nShort friendly paragraphs.\n## Steps\n- Write an outline",
    { origin: "home", path: "/home/specialists/blog-writer.md" },
  );
  if (!check.valid) throw new Error(check.defect);
  return check.specialist;
})();

test("a normal run follows the pinned specialist's steps; none pinned means no run", () => {
  expect(specialistForRun(writer, false)?.steps).toEqual(["Write an outline"]);
  expect(specialistForRun(undefined, false)).toBeUndefined();
});

test("a fix round keeps the instructions but swaps in the fix-round steps", () => {
  const run = specialistForRun(writer, true);
  expect(run?.specialist).toBe(writer);
  expect(run?.steps).not.toContain("Write an outline");
  expect(run?.steps.length).toBeGreaterThan(0);
  expect(specialistForRun(undefined, true)?.steps).toEqual(run?.steps ?? []);
});

test("only an implementer brief given a run carries the instructions and steps", () => {
  const base = {
    objective: "Write the launch post.",
    acceptanceCriteria: ["It is posted."],
    instructions: [],
    reportPath: "/tmp/report.md",
  };
  const run = specialistForRun(writer, false);
  const implementer = buildAgentBrief({
    ...base,
    role: "implementer",
    ...(run === undefined ? {} : { specialist: run }),
  });
  expect(implementer).toContain("Short friendly paragraphs.");
  expect(implementer).toContain("Write an outline");
  const fixRun = specialistForRun(writer, true);
  const fix = buildAgentBrief({
    ...base,
    role: "implementer",
    ...(fixRun === undefined ? {} : { specialist: fixRun }),
  });
  expect(fix).toContain("Short friendly paragraphs.");
  expect(fix).not.toContain("Write an outline");
  expect(buildAgentBrief({ ...base, role: "scout" })).not.toContain("Short friendly paragraphs.");
  const perf = specialistForRun(builtInSpecialist("perf"), false);
  expect(
    buildAgentBrief({
      ...base,
      role: "implementer",
      ...(perf === undefined ? {} : { specialist: perf }),
    }),
  ).toContain("Measure a baseline");
});
