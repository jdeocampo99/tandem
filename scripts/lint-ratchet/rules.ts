export type RatchetRule = Readonly<{
  id: string;
  hint: string;
  /** Files the rule is ratcheted in; others are left out of the counts. */
  appliesTo: (file: string) => boolean;
}>;

const isTest = (file: string): boolean => file.startsWith("tests/") || file.endsWith(".test.ts");
const everywhere = (): boolean => true;
/** Composition roots: the processes that pick real clocks and id sources for everything below. */
const ENTRY_POINTS = new Set([
  "src/main.ts",
  "src/cli.ts",
  "src/worker.ts",
  "src/validation-worker.ts",
  "src/harness/claude-code/sidecar.ts",
]);

/** Every ratcheted rule: Biome rules in ratchet.json, then the GritQL plugins it loads. */
export const RULES: readonly RatchetRule[] = [
  {
    id: "complexity/noExcessiveCognitiveComplexity",
    hint: "Split the function into named steps, or replace branching with a lookup table.",
    appliesTo: everywhere,
  },
  {
    id: "complexity/noExcessiveLinesPerFunction",
    hint: "Extract cohesive steps into named functions (limit 50 lines).",
    appliesTo: (file) => !isTest(file),
  },
  {
    id: "style/noNestedTernary",
    hint: "Use if/else, a switch, or a lookup table instead of nesting ternaries.",
    appliesTo: everywhere,
  },
  {
    id: "style/noExcessiveLinesPerFile",
    hint: "Split the file by responsibility (limit 300 lines).",
    appliesTo: everywhere,
  },
  {
    id: "complexity/useMaxParams",
    hint: "Group related parameters into one named object (limit 4).",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noUnnecessaryConditions",
    hint: "Delete the check; the types already decide it.",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noShadow",
    hint: "Rename the inner binding so it does not hide the outer one.",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noSkippedTests",
    hint: "Fix or delete the skipped test; gate machine-specific tests on an explicit flag.",
    appliesTo: everywhere,
  },
  {
    id: "tandem/hidden-clock",
    hint: "Inject a clock or id source (Clock, IdFactory) instead of reading time or randomness.",
    appliesTo: (file) => !ENTRY_POINTS.has(file),
  },
  {
    id: "tandem/json-parse-cast",
    hint: "Parse with a zod schema at the boundary instead of casting JSON.parse.",
    appliesTo: everywhere,
  },
  {
    id: "tandem/type-assertion",
    hint: "Narrow, parse, or fix the type instead of asserting it (`as const` is fine).",
    appliesTo: (file) => !isTest(file),
  },
];
