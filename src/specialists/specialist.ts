import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

/** Also a valid Jev option id, so a name can be offered to the classifier as is. */
export const SPECIALIST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** A specialist's instructions and steps together, in UTF-8 bytes; it goes into every implementer brief. */
export const MAX_SPECIALIST_BYTES = 8 * 1024;
const MAX_LABEL_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 300;
/** The numbers the Settings block checks against, so the Luau holds no copies of them. */
export const SPECIALIST_LIMITS = {
  nameLength: 40,
  /** UTF-16 units, as `String.length` counts them. */
  labelLength: MAX_LABEL_LENGTH,
  descriptionLength: MAX_DESCRIPTION_LENGTH,
  /** Instructions plus the steps joined by newlines, in UTF-8 bytes; also the whole file's cap. */
  contentBytes: MAX_SPECIALIST_BYTES,
} as const;
export const SPECIALIST_ORIGINS = ["built-in", "repository", "home"] as const;
export type SpecialistOrigin = (typeof SPECIALIST_ORIGINS)[number];
const FRONTMATTER_KEYS = ["name", "label", "description"] as const;
type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number];

/** Where a specialist came from; files keep the path they were read at. */
export type SpecialistSource =
  | Readonly<{ readonly origin: "built-in" }>
  | Readonly<{ readonly origin: "repository" | "home"; readonly path: string }>;

type SpecialistContent = SpecialistSource &
  Readonly<{
    readonly name: string;
    readonly label: string;
    /** What Tandem's guess reads; absent means the specialist is used only when named. */
    readonly description?: string;
    /** The body without its `## Steps` section; empty when the file has only steps. */
    readonly instructions: string;
    /** Loaded verbatim into the implementer's to-do list; unique, single-line; may be empty. */
    readonly steps: readonly string[];
  }>;

/**
 * A specialist as a task pins it: Tandem copied it at creation, so later edits to the file never
 * change the task. The same shape is a registry entry before it is pinned.
 */
export type Specialist = SpecialistContent &
  Readonly<{
    /** sha256 hex of the pinned content, recomputed on decode so a tampered record is refused. */
    readonly digest: string;
  }>;

export type SpecialistCheck =
  | Readonly<{ readonly valid: true; readonly specialist: Specialist }>
  | Readonly<{ readonly valid: false; readonly defect: string }>;

/** What a person writes: everything in a specialist file except its name, which is the file name. */
export type SpecialistFields = Readonly<{
  readonly label: string;
  /** Absent: used only when named. */
  readonly description?: string;
  readonly instructions: string;
  readonly steps: readonly string[];
}>;

export type SpecialistText =
  | Readonly<{ readonly ok: true; readonly text: string }>
  | Readonly<{ readonly ok: false; readonly problem: string }>;

type SpecialistField = "name" | "label" | "description" | "content" | "steps" | "digest" | "path";
type Defect = Readonly<{ readonly field: SpecialistField; readonly message: string }>;

const STEPS_HEADING = /^##\s+steps\s*$/iu;
const SECTION_END_HEADING = /^#{1,2}\s/u;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s+(.*))?$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const KEY_LINE = /^([A-Za-z0-9_-]+)\s*:(.*)$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * The digest of exactly what a task pins. `tandem specialists` shows the same value, so a user can
 * tell whether their file changed since a task pinned it.
 */
export function specialistDigest(content: SpecialistContent): string {
  const canonical = JSON.stringify({
    name: content.name,
    label: content.label,
    origin: content.origin,
    ...(content.origin === "built-in" ? {} : { path: content.path }),
    instructions: content.instructions,
    steps: content.steps,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Reads a specialist file's text: flat frontmatter, then instructions and an optional `## Steps` list. */
export function readSpecialistMarkdown(text: string, source: SpecialistSource): SpecialistCheck {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return invalid(1, "a specialist file starts with a --- frontmatter block");
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return invalid(1, "the frontmatter block is never closed with ---");

  const values = new Map<FrontmatterKey, Readonly<{ value: string; line: number }>>();
  for (let index = 1; index < close; index += 1) {
    const raw = lines[index] ?? "";
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = KEY_LINE.exec(trimmed);
    if (match === null) return invalid(line, "expected `key: value`");
    const key = match[1] ?? "";
    if (!isFrontmatterKey(key)) {
      return invalid(
        line,
        `unknown key "${key}"; a specialist's keys are ${FRONTMATTER_KEYS.join(", ")}`,
      );
    }
    if (values.has(key)) return invalid(line, `"${key}" appears twice`);
    const value = frontmatterValue(match[2] ?? "");
    if (value === undefined) return invalid(line, `the value of "${key}" has an unclosed quote`);
    values.set(key, { value, line });
  }

  const name = values.get("name");
  if (name === undefined) return invalid(1, "the frontmatter has no name");
  const body = splitBody(lines.slice(close + 1), close + 2);
  if ("problem" in body) return invalid(body.line, body.problem);

  const label = values.get("label");
  const description = values.get("description");
  const content: SpecialistContent = {
    ...source,
    name: name.value,
    label: label?.value ?? name.value,
    ...(description === undefined ? {} : { description: description.value }),
    instructions: body.instructions,
    steps: body.steps,
  };
  const specialist: Specialist = { ...content, digest: specialistDigest(content) };
  const defect = specialistDefect(specialist);
  if (defect === undefined) return { valid: true, specialist };
  const line =
    defect.field === "name" || defect.field === "label" || defect.field === "description"
      ? (values.get(defect.field)?.line ?? 1)
      : defect.field === "steps"
        ? body.stepsLine
        : 1;
  return invalid(line, defect.message);
}

/** Checks a stored specialist snapshot without throwing, so the codec raises its own error. */
export function checkSpecialist(value: unknown): SpecialistCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, defect: "must be an object" };
  }
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const allowed = [
    "origin",
    "path",
    "name",
    "label",
    "description",
    "instructions",
    "steps",
    "digest",
  ];
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return { valid: false, defect: `unknown field ${unknown}` };
  const { origin, path, name, label, description, instructions, steps, digest } = record;
  if (typeof name !== "string") return { valid: false, defect: "name must be text" };
  if (typeof label !== "string") return { valid: false, defect: "label must be text" };
  if (description !== undefined && typeof description !== "string") {
    return { valid: false, defect: "description must be text" };
  }
  if (typeof instructions !== "string") {
    return { valid: false, defect: "instructions must be text" };
  }
  const stepList = Array.isArray(steps)
    ? steps.filter((step): step is string => typeof step === "string")
    : undefined;
  if (stepList === undefined || !Array.isArray(steps) || stepList.length !== steps.length) {
    return { valid: false, defect: "steps must be a list of text" };
  }
  if (typeof digest !== "string") return { valid: false, defect: "digest must be text" };
  let source: SpecialistSource;
  if (origin === "built-in") {
    if (path !== undefined) return { valid: false, defect: "a built-in specialist has no path" };
    source = { origin };
  } else if (origin === "repository" || origin === "home") {
    if (typeof path !== "string") return { valid: false, defect: "path must be text" };
    source = { origin, path };
  } else {
    return { valid: false, defect: `origin must be one of ${SPECIALIST_ORIGINS.join(", ")}` };
  }
  const specialist: Specialist = {
    ...source,
    name,
    label,
    ...(description === undefined ? {} : { description }),
    instructions,
    steps: stepList,
    digest,
  };
  const defect = specialistDefect(specialist);
  return defect === undefined
    ? { valid: true, specialist }
    : { valid: false, defect: defect.message };
}

/**
 * The file Tandem writes for `name` and `fields`: flat frontmatter, the instructions, then a
 * `## Steps` list. Trims the fields first, and refuses anything the parser refuses, a file over
 * MAX_SPECIALIST_BYTES (the loader's whole-file cap), a value no quoting can hold, and fields that
 * would not read back as themselves, such as an unclosed code fence or a `## Steps` heading inside
 * the instructions: it serializes, reads the text back, and compares.
 */
export function specialistMarkdown(name: string, fields: SpecialistFields): SpecialistText {
  if (!SPECIALIST_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      problem: `"${name}" is not a specialist name; use lowercase letters, digits, and hyphens (at most 40)`,
    };
  }
  const wanted = trimmedFields(fields);
  const source: SpecialistSource = { origin: "home", path: `/${name}.md` };
  const content: SpecialistContent = { ...source, name, ...wanted };
  const defect = specialistDefect({ ...content, digest: specialistDigest(content) });
  if (defect !== undefined) return { ok: false, problem: defect.message };
  const label = frontmatterText("label", wanted.label);
  if (!label.ok) return label;
  const description =
    wanted.description === undefined
      ? undefined
      : frontmatterText("description", wanted.description);
  if (description !== undefined && !description.ok) return description;
  const steps =
    wanted.steps.length === 0 ? [] : ["## Steps", ...wanted.steps.map((step) => `- ${step}`)];
  const body = [wanted.instructions, steps.join("\n")].filter((part) => part.length > 0);
  const text = [
    "---",
    `name: ${name}`,
    `label: ${label.text}`,
    ...(description === undefined ? [] : [`description: ${description.text}`]),
    "---",
    `${body.join("\n\n")}\n`,
  ].join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SPECIALIST_BYTES) {
    return {
      ok: false,
      problem: `the file would be ${bytes} bytes; a specialist file is at most ${MAX_SPECIALIST_BYTES}`,
    };
  }
  const read = readSpecialistMarkdown(text, source);
  if (!read.valid) return { ok: false, problem: read.defect.replace(/^line \d+: /u, "") };
  if (read.specialist.name !== name || !sameFields(specialistFields(read.specialist), wanted)) {
    return {
      ok: false,
      problem:
        "the instructions would not read back as written; close every code fence and leave out a ## Steps heading",
    };
  }
  return { ok: true, text };
}

/** The inverse of specialistMarkdown: what Settings shows in a specialist's form. */
export function specialistFields(specialist: SpecialistContent): SpecialistFields {
  return {
    label: specialist.label,
    ...(specialist.description === undefined ? {} : { description: specialist.description }),
    instructions: specialist.instructions,
    steps: specialist.steps,
  };
}

function trimmedFields(fields: SpecialistFields): SpecialistFields {
  const description = fields.description?.trim() ?? "";
  return {
    label: fields.label.trim(),
    ...(description.length === 0 ? {} : { description }),
    instructions: fields.instructions.replace(/\r\n/gu, "\n").trim(),
    steps: fields.steps.map((step) => step.trim()),
  };
}

function sameFields(left: SpecialistFields, right: SpecialistFields): boolean {
  return (
    left.label === right.label &&
    left.description === right.description &&
    left.instructions === right.instructions &&
    left.steps.length === right.steps.length &&
    left.steps.every((step, index) => step === right.steps[index])
  );
}

/** The quoting frontmatterValue reads back: bare unless ` #` or a leading quote needs quotes. */
function frontmatterText(field: string, value: string): SpecialistText {
  if (!value.includes(" #") && !value.startsWith('"') && !value.startsWith("'")) {
    return { ok: true, text: value };
  }
  if (!value.includes('"')) return { ok: true, text: `"${value}"` };
  if (!value.includes("'")) return { ok: true, text: `'${value}'` };
  return { ok: false, problem: `${field} can't hold both quote kinds and " #"` };
}

/** The one invariant both readers end in: name, label, description, steps, size, digest, path. */
function specialistDefect(candidate: Specialist): Defect | undefined {
  if (!SPECIALIST_NAME_PATTERN.test(candidate.name)) {
    return {
      field: "name",
      message: `"${candidate.name}" is not a specialist name; use lowercase letters, digits, and hyphens (at most 40)`,
    };
  }
  const label = lineDefect(candidate.label, "label", MAX_LABEL_LENGTH);
  if (label !== undefined) return { field: "label", message: label };
  if (candidate.description !== undefined) {
    const description = lineDefect(candidate.description, "description", MAX_DESCRIPTION_LENGTH);
    if (description !== undefined) return { field: "description", message: description };
  }
  if (candidate.instructions.trim().length === 0 && candidate.steps.length === 0) {
    return { field: "content", message: "a specialist needs instructions, steps, or both" };
  }
  const seen = new Set<string>();
  for (const step of candidate.steps) {
    if (step.trim().length === 0 || step !== step.trim() || /[\r\n]/u.test(step)) {
      return { field: "steps", message: `step "${step}" must be one non-empty line` };
    }
    if (seen.has(step)) return { field: "steps", message: `step "${step}" appears twice` };
    seen.add(step);
  }
  const bytes = Buffer.byteLength(candidate.instructions + candidate.steps.join("\n"), "utf8");
  if (bytes > MAX_SPECIALIST_BYTES) {
    return {
      field: "content",
      message: `instructions and steps are ${bytes} bytes; the limit is ${MAX_SPECIALIST_BYTES}`,
    };
  }
  if (candidate.origin !== "built-in" && !isAbsolute(candidate.path)) {
    return { field: "path", message: "path must be absolute" };
  }
  if (!DIGEST.test(candidate.digest) || candidate.digest !== specialistDigest(candidate)) {
    return { field: "digest", message: "digest does not match the specialist's content" };
  }
  return undefined;
}

type Body =
  | Readonly<{
      readonly instructions: string;
      readonly steps: readonly string[];
      readonly stepsLine: number;
    }>
  | Readonly<{ readonly line: number; readonly problem: string }>;

/** Splits the body into instructions and the `## Steps` list; `firstLine` is the file line of `lines[0]`. */
function splitBody(lines: readonly string[], firstLine: number): Body {
  let fence: string | undefined;
  let stepsStart: number | undefined;
  let stepsEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (STEPS_HEADING.test(line.trim())) {
      if (stepsStart !== undefined) {
        return {
          line: firstLine + index,
          problem: "a specialist has at most one ## Steps section",
        };
      }
      stepsStart = index;
      stepsEnd = lines.length;
      continue;
    }
    if (stepsStart !== undefined && stepsEnd === lines.length && SECTION_END_HEADING.test(line)) {
      stepsEnd = index;
    }
  }
  if (stepsStart === undefined) {
    return { instructions: lines.join("\n").trim(), steps: [], stepsLine: firstLine };
  }
  const steps: string[] = [];
  for (let index = stepsStart + 1; index < stepsEnd; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const item = LIST_ITEM.exec(line);
    const step = item?.[1]?.trim() ?? "";
    if (item === null) {
      return {
        line: firstLine + index,
        problem: "each line under ## Steps must be one list item (-, *, + or 1.)",
      };
    }
    if (step.length === 0) return { line: firstLine + index, problem: "a step is empty" };
    if (steps.includes(step)) {
      return { line: firstLine + index, problem: `step "${step}" appears twice` };
    }
    steps.push(step);
  }
  const instructions = [...lines.slice(0, stepsStart), ...lines.slice(stepsEnd)].join("\n").trim();
  return { instructions, steps, stepsLine: firstLine + stepsStart };
}

/** An unquoted value ends at ` #`; a quoted one is taken whole. Undefined is an unclosed quote. */
function frontmatterValue(raw: string): string | undefined {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end === -1) return undefined;
    const rest = value.slice(end + 1).trim();
    if (rest.length > 0 && !rest.startsWith("#")) return undefined;
    return value.slice(1, end);
  }
  const comment = value.indexOf(" #");
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function lineDefect(value: string, field: string, max: number): string | undefined {
  if (value.trim().length === 0) return `${field} is empty`;
  if (/[\r\n]/u.test(value)) return `${field} must be one line`;
  if (value.length > max) return `${field} is ${value.length} characters; the limit is ${max}`;
  return undefined;
}

function isFrontmatterKey(key: string): key is FrontmatterKey {
  return FRONTMATTER_KEYS.some((known) => known === key);
}

function invalid(line: number, problem: string): SpecialistCheck {
  return { valid: false, defect: `line ${line}: ${problem}` };
}
