import { readSpecialistMarkdown, type Specialist } from "./specialist.ts";

const FEATURE_STEPS = `- Look for code to reuse or dead code to delete
- Build it
- Add a test through the public entry point
- Check what happens if it runs twice or fails halfway`;

/**
 * Same format as a user's file, so a user can copy one and change it. These names are durable ids:
 * older tasks pinned them as `playbook`, so renaming one breaks those records.
 */
const SOURCES = [
  `---
name: bug-fix
label: Bug fix
description: Something that used to work, or should work, behaves wrongly and must be fixed.
---
## Steps
- Write a failing test that reproduces the bug
- Find where the bug starts
- Fix it where it starts
- See the failing test pass
- Commit the test before the fix
`,
  `---
name: feature
label: Feature
description: New behavior or capability is added.
---
## Steps
- Name the data the feature works on
${FEATURE_STEPS}
`,
  `---
name: refactor
label: Refactor
description: The code's structure changes while its behavior stays the same.
---
## Steps
- Confirm tests cover the current behavior
- Change the structure
- Move every caller to the new structure
- Delete the old version
`,
  `---
name: perf
label: Performance
description: Existing behavior must get faster or use fewer resources.
---
## Steps
- Measure a baseline
- Find the cause
- Fix the cause
- Measure again
`,
  `---
name: general
label: General
description: None of the others fits, or more than one fits equally.
---
## Steps
${FEATURE_STEPS}
`,
] as const;

export const BUILT_IN_SPECIALISTS: readonly Specialist[] = SOURCES.map(builtIn);

/** Always exists (a built-in can be replaced, never removed): the pick when nothing else is chosen. */
export const FALLBACK_SPECIALIST = "general";

/** Older tasks' `playbook` ids are these names, so the codec decodes them through this lookup. */
export function builtInSpecialist(name: string): Specialist | undefined {
  return BUILT_IN_SPECIALISTS.find((specialist) => specialist.name === name);
}

function builtIn(text: string): Specialist {
  const check = readSpecialistMarkdown(text, { origin: "built-in" });
  if (!check.valid) throw new Error(`built-in specialist is invalid: ${check.defect}`);
  return check.specialist;
}
