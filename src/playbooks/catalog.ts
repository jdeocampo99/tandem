/** The playbooks a task can pin at creation. */
export const PINNABLE_PLAYBOOK_IDS = ["bug-fix", "feature", "refactor", "perf", "general"] as const;
/** `fix-round` is never pinned; code picks it whenever a fix round runs. */
export const PLAYBOOK_IDS = [...PINNABLE_PLAYBOOK_IDS, "fix-round"] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];
export type PinnablePlaybookId = (typeof PINNABLE_PLAYBOOK_IDS)[number];

export type Playbook = Readonly<{
  readonly title: string;
  /** Loaded verbatim into the implementer's to-do list, so each stays short and unique. */
  readonly steps: readonly string[];
}>;

const FEATURE_STEPS = [
  "Look for code to reuse or dead code to delete",
  "Build it",
  "Add a test through the public entry point",
  "Check what happens if it runs twice or fails halfway",
] as const;

/** The work itself only: research, the brief, validation, review, and PRs stay Tandem's task flow. */
export const PLAYBOOKS: Readonly<Record<PlaybookId, Playbook>> = {
  "bug-fix": {
    title: "bug fix",
    steps: [
      "Write a failing test that reproduces the bug",
      "Find where the bug starts",
      "Fix it where it starts",
      "See the failing test pass",
      "Commit the test before the fix",
    ],
  },
  feature: {
    title: "feature",
    steps: ["Name the data the feature works on", ...FEATURE_STEPS],
  },
  refactor: {
    title: "refactor",
    steps: [
      "Confirm tests cover the current behavior",
      "Change the structure",
      "Move every caller to the new structure",
      "Delete the old version",
    ],
  },
  perf: {
    title: "perf",
    steps: ["Measure a baseline", "Find the cause", "Fix the cause", "Measure again"],
  },
  general: { title: "general", steps: FEATURE_STEPS },
  "fix-round": {
    title: "fix round",
    steps: [
      "Fix every P0 and P1 finding; leave P2 and P3 as known issues",
      "Confirm each finding is gone",
      "Question the first fix's assumption for any repeat finding",
    ],
  },
};
