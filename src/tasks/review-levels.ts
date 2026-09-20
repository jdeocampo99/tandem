import type {
  ReviewLens,
  ReviewLevel,
  ReviewLevelPolicy,
  ReviewLevelRecord,
  SafetyFloor,
  TaskRecord,
} from "../contracts.ts";
import { REVIEW_LEVEL_ORDER, SAFETY_FLOOR_ORDER } from "../contracts.ts";
import type { EscalationReason } from "./acceptance.ts";
import { FINAL_REVIEW_LENSES } from "./acceptance.ts";

/**
 * The bounds that separate a contained change from a broader one. They are provisional: nothing
 * here has been calibrated against real tasks yet, and the documented end-to-end evaluation in
 * issue #20 must land before any of them is allowed to reduce what actually runs.
 */
export const LIGHT_CLASSIFICATION_LIMITS = {
  maxChangedFiles: 5,
  maxAffectedCallers: 2,
} as const;

/** The single lens a light iteration round reviews when a repository has opted into reduced routing. */
export const LIGHT_ITERATION_LENSES: readonly ReviewLens[] = ["behavior"];

/** The review-level settings a repository gets when it configures nothing. */
export const DEFAULT_REVIEW_LEVEL_POLICY: ReviewLevelPolicy = {
  reducedRouting: false,
  deepScrutiny: false,
  jevAssistance: "off",
  sourceTransmission: false,
};

/** What a changed file's content is about, as observed from the patch rather than its extension. */
export type ChangeCategory =
  | "permissions-security"
  | "data-integrity"
  | "shared-contract"
  | "concurrency"
  | "dependency-build-infra"
  | "tests"
  | "documentation"
  | "contained-implementation"
  | "unobserved";

export type SafetyFloorDefinition = Readonly<{
  readonly minimumLevel: ReviewLevel;
  readonly categories: readonly ChangeCategory[];
  readonly scrutiny: string;
}>;

/**
 * The fixed floors. Each names the least level its change kind may ever be reviewed at and the
 * scrutiny a reviewer must record for it, so an enabled level can never drop the dimension.
 */
export const SAFETY_FLOORS: Readonly<Record<SafetyFloor, SafetyFloorDefinition>> = {
  "permissions-security": {
    minimumLevel: "deep",
    categories: ["permissions-security"],
    scrutiny:
      "permissions and security: account for every changed authentication, authorization, credential, ownership, and cryptographic path, and say what an unauthorized caller can now reach",
  },
  "data-integrity": {
    minimumLevel: "deep",
    categories: ["data-integrity"],
    scrutiny:
      "migrations and data integrity: account for schema, migration, serialization, and durable-record changes, and say what happens to records written by an earlier build",
  },
  "shared-contracts-concurrency": {
    minimumLevel: "deep",
    categories: ["shared-contract", "concurrency"],
    scrutiny:
      "shared contracts and concurrency: account for every changed exported declaration and every lock, ordering, or interleaving assumption, and name the callers that must change with it",
  },
  "dependency-build-infra": {
    minimumLevel: "standard",
    categories: ["dependency-build-infra"],
    scrutiny:
      "dependencies, build, and infrastructure: account for changed manifests, lockfiles, build configuration, and deployment definitions, and say what the change adds to the trusted supply chain",
  },
};

/** One changed file with the diff content that was actually observed for it. */
export type ChangedFileObservation = Readonly<{
  readonly path: string;
  readonly changedLines: readonly string[];
  readonly contentObserved: boolean;
}>;

/** How wide the round's change is, in the vocabulary the review brief already records. */
export type ReviewImpactObservation = Readonly<{
  readonly assessment: "contained" | "expanded" | "unknown";
  readonly escalation?: EscalationReason;
}>;

export type ReviewLevelClassificationInput = Readonly<{
  readonly files: readonly ChangedFileObservation[];
  readonly affectedCallers: readonly string[];
  readonly impact: ReviewImpactObservation;
}>;

/**
 * The classification a task is reviewed under. A durable record written before review levels
 * existed carries none, so it reads as the conservative `standard` default rather than as the
 * cheapest level. A present record is used exactly as the codec parsed it.
 */
export function recordedReviewLevel(task: TaskRecord): ReviewLevelRecord {
  return (
    task.reviewLevel ?? {
      level: "standard",
      reason:
        "no review level is recorded for this task, so it is reviewed at the conservative default",
      floors: [],
    }
  );
}

/** Orders two levels, so a recorded level can be raised but never quietly lowered. */
export function maxReviewLevel(left: ReviewLevel, right: ReviewLevel): ReviewLevel {
  return REVIEW_LEVEL_ORDER.indexOf(left) >= REVIEW_LEVEL_ORDER.indexOf(right) ? left : right;
}

/**
 * Splits one unified diff into the changed lines observed per file. A file the patch does not
 * describe, a binary file, and every file in a truncated patch stay unobserved, which classifies
 * conservatively rather than pretending the content was read.
 */
export function observeChangedFiles(
  input: Readonly<{
    readonly changedFiles: readonly string[];
    readonly patch: string;
    readonly truncated: boolean;
  }>,
): readonly ChangedFileObservation[] {
  const observed = input.truncated ? new Map<string, string[]>() : readPatchLines(input.patch);
  return input.changedFiles.map((path) => {
    const changedLines = observed.get(path);
    return changedLines === undefined
      ? { path, changedLines: [], contentObserved: false }
      : { path, changedLines, contentObserved: true };
  });
}

/**
 * Chooses the review level from the changed paths, the content observed for them, the affected
 * callers, and the round's impact assessment. Nothing here reads a line count, a task title, or a
 * file extension on its own: a path only categorizes a file when it names an enumerated sensitive
 * location, and every other category comes from the diff content.
 */
export function classifyReviewLevel(input: ReviewLevelClassificationInput): ReviewLevelRecord {
  const categorized = input.files.map((file) => ({
    path: file.path,
    categories: changeCategoriesFor(file),
  }));
  const floors = SAFETY_FLOOR_ORDER.filter((floor) =>
    categorized.some((file) =>
      file.categories.some((category) => SAFETY_FLOORS[floor].categories.includes(category)),
    ),
  );
  const floorLevel = floors.reduce<ReviewLevel>(
    (level, floor) => maxReviewLevel(level, SAFETY_FLOORS[floor].minimumLevel),
    "light",
  );
  const base = baseClassification({ ...input, categorized });
  const level = maxReviewLevel(base.level, floorLevel);
  const floorReason =
    floors.length === 0
      ? ""
      : `; safety floor(s) ${floors.join(", ")} force at least ${floorLevel}`;
  return {
    level,
    reason: `${base.reason}${floorReason}`,
    floors,
  };
}

/**
 * Merges a fresh classification into the recorded one. A grown or newly sensitive change raises
 * the level; a narrower observation keeps the recorded level and says why, so the level a task is
 * reviewed at never drops while the task is in flight.
 */
export function reclassifyReviewLevel(
  previous: ReviewLevelRecord | undefined,
  observed: ReviewLevelRecord,
): ReviewLevelRecord {
  if (previous === undefined) return observed;
  const floors = SAFETY_FLOOR_ORDER.filter(
    (floor) => previous.floors.includes(floor) || observed.floors.includes(floor),
  );
  const level = maxReviewLevel(previous.level, observed.level);
  const retained = level !== observed.level;
  return {
    level,
    reason: retained
      ? `${observed.reason}; retained the recorded ${previous.level} level because a classified level never drops`
      : observed.reason,
    floors,
    ...(previous.assistance === undefined ? {} : { assistance: previous.assistance }),
  };
}

/**
 * The lenses this round must review. Reduced routing is off unless the repository opted in, so by
 * default every round reviews the complete final lens set exactly as it did before levels existed.
 * A light round can only narrow an iteration round whose final manifest has not run at this HEAD;
 * once the final manifest is recorded the complete set is required again, which keeps issue #17's
 * final acceptance contract intact at every level.
 */
export function requiredReviewLenses(task: TaskRecord, head: string): readonly ReviewLens[] {
  const level = recordedReviewLevel(task).level;
  const policy = task.policy.config.reviewLevels;
  if (!policy.reducedRouting || level !== "light") return FINAL_REVIEW_LENSES;
  if (task.iterationScope === undefined) return FINAL_REVIEW_LENSES;
  const finalRecorded = task.validationEvidence.some(
    (entry) => entry.contract === "final" && entry.head === head,
  );
  return finalRecorded ? FINAL_REVIEW_LENSES : LIGHT_ITERATION_LENSES;
}

/**
 * The scrutiny a deep round must record, one line per fired floor. Empty unless the repository
 * enabled deep scrutiny and the change classified deep, so the default brief is unchanged.
 */
export function deepScrutinyRequirements(
  record: ReviewLevelRecord | undefined,
  policy: ReviewLevelPolicy,
): readonly string[] {
  if (record === undefined || record.level !== "deep" || !policy.deepScrutiny) return [];
  return record.floors.map((floor) => SAFETY_FLOORS[floor].scrutiny);
}

/**
 * Applies a helper's depth recommendation. A recommendation can only raise the deterministic
 * level; a lower or equal one leaves the deterministic level untouched, so no helper answer,
 * however confident, can reach below a safety floor.
 */
export function raiseReviewLevel(
  record: ReviewLevelRecord,
  recommendation: ReviewLevel | "unavailable",
): ReviewLevel {
  return recommendation === "unavailable"
    ? record.level
    : maxReviewLevel(record.level, recommendation);
}

/**
 * The level the task is reviewed at once assistance is considered. Shadow assistance records its
 * recommendation without using it, so the level stays exactly the deterministic one.
 */
export function assistedReviewLevel(
  record: ReviewLevelRecord,
  policy: ReviewLevelPolicy,
): ReviewLevel {
  return policy.jevAssistance === "shadow"
    ? record.level
    : raiseReviewLevel(record, record.assistance?.recommendation ?? "unavailable");
}

const SENSITIVE_PATH_RULES: readonly Readonly<{
  readonly category: ChangeCategory;
  readonly pattern: RegExp;
}>[] = [
  {
    category: "dependency-build-infra",
    pattern:
      /(^|\/)(package\.json|package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Dockerfile|Makefile|tsconfig(\.[\w-]+)?\.json|biome\.json|\.npmrc)$/u,
  },
  {
    category: "dependency-build-infra",
    pattern: /(^|\/)(\.github|\.circleci|\.gitlab-ci\.yml|infra|deploy|terraform|helm|k8s)(\/|$)/u,
  },
  { category: "data-integrity", pattern: /(^|\/)migrations?(\/|$)/u },
  { category: "tests", pattern: /(^|\/)(tests?|__tests__|spec)(\/|$)/u },
  { category: "tests", pattern: /\.(test|spec)\.[A-Za-z0-9]+$/u },
  { category: "documentation", pattern: /(^|\/)(docs?)(\/|$)|(^|\/)README[^/]*$/u },
];

const CONTENT_RULES: readonly Readonly<{
  readonly category: ChangeCategory;
  readonly pattern: RegExp;
}>[] = [
  {
    category: "permissions-security",
    pattern:
      /(auth|permission|privilege|credential|secret|api[_-]?key|password|passphrase|bearer|oauth|signature|hmac|encrypt|decrypt|certificate|setuid|chmod|sudo)/iu,
  },
  {
    category: "data-integrity",
    pattern:
      /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|ADD\s+COLUMN|CREATE\s+INDEX|PRAGMA|migrat\w*|schemaVersion|serialize|deserialize|parseTaskRecord|checksum|digest)\b/iu,
  },
  {
    category: "shared-contract",
    pattern: /^[+-]?\s*export\s+(type|interface|const|enum|class|function|default|\{)/u,
  },
  {
    /**
     * `lock` is matched only when it starts a word or a camel-case segment, so `blockTask` and
     * `blockReason` do not read as concurrency while `withStateLock` and `unlock` do.
     */
    category: "concurrency",
    pattern:
      /(?:^|[^A-Za-z])(?:un)?lock|[a-z]Lock|\b(?:mutex|semaphore|atomic|fencing|concurrent|concurrency|reentrant|O_EXLOCK|worker_threads|SharedArrayBuffer)\b|Promise\.(?:all|race|allSettled)/u,
  },
  {
    category: "dependency-build-infra",
    pattern: /"(dependencies|devDependencies|peerDependencies|trustedDependencies)"\s*:/u,
  },
];

function readPatchLines(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let currentPath: string | undefined;
  let current: string[] | undefined;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(?<from>.+?) b\/(?<to>.+)$/u.exec(line);
    if (header !== null) {
      currentPath = header.groups?.to ?? header.groups?.from;
      current = currentPath === undefined ? undefined : [];
      if (currentPath !== undefined && current !== undefined) files.set(currentPath, current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      if (currentPath !== undefined) files.delete(currentPath);
      currentPath = undefined;
      current = undefined;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) current.push(line);
  }
  return files;
}

function changeCategoriesFor(file: ChangedFileObservation): readonly ChangeCategory[] {
  const categories = new Set<ChangeCategory>();
  for (const rule of SENSITIVE_PATH_RULES) {
    if (rule.pattern.test(file.path)) categories.add(rule.category);
  }
  if (!file.contentObserved) {
    categories.add("unobserved");
    return [...categories];
  }
  for (const rule of CONTENT_RULES) {
    if (file.changedLines.some((line) => rule.pattern.test(line))) categories.add(rule.category);
  }
  if (categories.size === 0) categories.add("contained-implementation");
  return [...categories];
}

const BENIGN_CATEGORIES: readonly ChangeCategory[] = [
  "tests",
  "documentation",
  "contained-implementation",
];

function baseClassification(
  input: ReviewLevelClassificationInput &
    Readonly<{
      readonly categorized: readonly Readonly<{
        readonly path: string;
        readonly categories: readonly ChangeCategory[];
      }>[];
    }>,
): Readonly<{ readonly level: ReviewLevel; readonly reason: string }> {
  if (input.categorized.length === 0) {
    return {
      level: "standard",
      reason: "no changed file was observed, so the change cannot be bounded",
    };
  }
  if (input.impact.assessment === "unknown") {
    return {
      level: "deep",
      reason: `the round's impact is unknown${
        input.impact.escalation === undefined ? "" : ` (${input.impact.escalation})`
      }, so the change is classified conservatively`,
    };
  }
  const unobserved = input.categorized.filter((file) => file.categories.includes("unobserved"));
  if (unobserved.length > 0) {
    return {
      level: "standard",
      reason: `the diff content for ${unobserved.length} changed file(s) could not be observed, so the change is classified conservatively`,
    };
  }
  if (input.impact.assessment === "expanded") {
    return {
      level: "standard",
      reason:
        "the change reached outside the surface this round was authorized to touch, so its scope grew",
    };
  }
  const sensitive = input.categorized.filter((file) =>
    file.categories.some((category) => !BENIGN_CATEGORIES.includes(category)),
  );
  if (sensitive.length > 0) {
    return {
      level: "standard",
      reason: `${sensitive.length} changed file(s) carry content outside contained implementation, tests, and documentation`,
    };
  }
  if (input.categorized.length > LIGHT_CLASSIFICATION_LIMITS.maxChangedFiles) {
    return {
      level: "standard",
      reason: `${input.categorized.length} changed file(s) exceed the ${LIGHT_CLASSIFICATION_LIMITS.maxChangedFiles} a contained change is bounded to`,
    };
  }
  if (input.affectedCallers.length > LIGHT_CLASSIFICATION_LIMITS.maxAffectedCallers) {
    return {
      level: "standard",
      reason: `${input.affectedCallers.length} affected caller(s) exceed the ${LIGHT_CLASSIFICATION_LIMITS.maxAffectedCallers} a contained change is bounded to`,
    };
  }
  return {
    level: "light",
    reason: `the observed diff is contained: ${input.categorized.length} changed file(s) of contained implementation, tests, or documentation with ${input.affectedCallers.length} affected caller(s) and no safety floor`,
  };
}
