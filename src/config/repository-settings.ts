import { defaultPolicy } from "./policy.ts";

/** The user's answer to "how does this repository merge?", as saved into `[merging]`. */
export type MergingChoice =
  | Readonly<{ readonly mergeWith: "auto-merge" | "off" }>
  | Readonly<{
      readonly mergeWith: "queue-label";
      readonly queueLabel: string;
      readonly blockedLabel?: string;
    }>;

export type RepositoryCommandEdit = Readonly<{
  setupCommands?: readonly string[];
  validationCommands?: readonly string[];
  /** True saves no checks; false removes the choice; undefined leaves it untouched. */
  noChecks?: boolean;
}>;

type SettingsEdit =
  | (RepositoryCommandEdit & Readonly<{ kind: "commands" }>)
  | Readonly<{ kind: "merging"; choice: MergingChoice; existingTable: boolean }>;

export function applySettingsEdit(text: string, edit: SettingsEdit): string {
  if (edit.kind === "merging") {
    const lines = mergingLines(edit.choice);
    return edit.existingTable
      ? text.replace(/^\[merging\][ \t]*$/mu, `[merging]\n${lines.trimEnd()}`)
      : `${text.replace(/\n*$/u, "\n")}\n[merging]\n${lines}`;
  }
  let after = text;
  for (const key of ["setupCommands", "validationCommands"] as const) {
    const values = edit[key];
    if (values !== undefined) after = withCommandList(after, key, values);
  }
  return edit.noChecks === undefined ? after : withNoChecks(after, edit.noChecks);
}

function mergingLines(choice: MergingChoice): string {
  const lines = [`mergeWith = ${JSON.stringify(choice.mergeWith)}`];
  if (choice.mergeWith === "queue-label") {
    lines.push(`queueLabel = ${JSON.stringify(choice.queueLabel)}`);
    if (choice.blockedLabel !== undefined) {
      lines.push(`blockedLabel = ${JSON.stringify(choice.blockedLabel)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The index just past the TOML array opening at `open`; brackets inside strings or comments don't count. */
function listEnd(text: string, open: number): number {
  if (text[open] !== "[")
    throw new TypeError("settings.toml has a command setting that is not a list");
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (char === '"' && text[index] === "\\") index += 1;
        index += 1;
      }
    } else if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new TypeError("settings.toml has an unterminated command list");
}

/**
 * Sets one top-level command list: in place when the file has it, over the commented example when
 * it only has that, else just above the first table. Nothing else in the file changes.
 */
function withCommandList(text: string, key: string, values: readonly string[]): string {
  const line = `${key} = ${tomlList(values)}`;
  const tableStart = text.search(/^[ \t]*\[/mu);
  const head = tableStart === -1 ? text : text.slice(0, tableStart);
  const tail = text.slice(head.length);
  const set = new RegExp(`^${key}[ \\t]*=[ \\t]*`, "mu").exec(head);
  if (set !== null) {
    return (
      head.slice(0, set.index) + line + head.slice(listEnd(head, set.index + set[0].length)) + tail
    );
  }
  const example = new RegExp(`^#[ \\t]*${key}[ \\t]*=.*$`, "mu").exec(head);
  if (example !== null) {
    return (
      head.slice(0, example.index) + line + head.slice(example.index + example[0].length) + tail
    );
  }
  return `${head.replace(/\n*$/u, "\n")}\n${line}\n${tail === "" ? "" : `\n${tail}`}`;
}

/**
 * Sets or clears the top-level `validation = "none"` line, the user's "no checks"; it goes just
 * above `validationCommands` when the file has that line, else above the first table.
 */
function withNoChecks(text: string, noChecks: boolean): string {
  const tableStart = text.search(/^[ \t]*\[/mu);
  const head = tableStart === -1 ? text : text.slice(0, tableStart);
  const tail = text.slice(head.length);
  const set = /^validation[ \t]*=.*\n?/mu.exec(head);
  if (!noChecks) {
    return set === null
      ? text
      : head.slice(0, set.index) + head.slice(set.index + set[0].length) + tail;
  }
  if (set !== null) {
    return `${head.slice(0, set.index)}${NO_CHECKS_LINE}\n${head.slice(set.index + set[0].length)}${tail}`;
  }
  const anchor = /^#?[ \t]*validationCommands[ \t]*=/mu.exec(head);
  if (anchor !== null) {
    return `${head.slice(0, anchor.index)}${NO_CHECKS_LINE}\n${head.slice(anchor.index)}${tail}`;
  }
  return `${head.replace(/\n*$/u, "\n")}\n${NO_CHECKS_LINE}\n${tail === "" ? "" : `\n${tail}`}`;
}

function tomlList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * Writes settings.toml with the proposed commands filled in and every other setting present but
 * commented out, each with what it does and an example, so the file documents itself.
 */
export function serializeCentralConfig(
  root: string,
  commands: Required<RepositoryCommandEdit>,
): string {
  const { validationCommands, setupCommands, noChecks } = commands;
  const defaults = defaultPolicy();
  const setting = (values: readonly string[], key: string, example: string): string =>
    values.length > 0 ? `${key} = ${tomlList(values)}` : `# ${key} = ${example}`;
  const validation = noChecks
    ? `${NO_CHECKS_LINE}\nvalidationCommands = []`
    : setting(validationCommands, "validationCommands", '["npm run lint", "npm test"]');
  return `# Tandem settings for this project. Edit with \`tandem config\`.
# Uncomment a line (remove the leading "#") to turn a setting on.
# Changes apply to tasks started afterwards; running tasks keep the settings they began with.

# The repository these settings belong to. Don't change this.
repoPath = ${JSON.stringify(root)}

# Commands that prepare a fresh working copy before a coding agent starts, like installing
# dependencies. They run every time an agent starts, so they should be safe to repeat.
${setting(setupCommands, "setupCommands", '["npm ci", "npx prisma generate"]')}

# Checks every change must pass before Tandem accepts it. Each one runs in the project folder.
# For no checks at all, set validation = "none" with no validationCommands: tasks then skip
# validation and are labeled unvalidated.
${validation}

# Commands that stop what agents started in a working copy, like a Docker or database stack.
# They run in the task's working copy once the task is finished and its agents are closed.
# cleanupCommands = ["docker compose down"]

# How many times reviewers may send a change back for fixes before Tandem asks you.
# maxFixRounds = ${defaults.maxFixRounds}

# Tandem gives coding agents and reviewers its own code standards and principles. Set "none" to
# leave them out and let this repository's AGENTS.md, CLAUDE.md, and instructions govern.
# standards = "tandem"

# Extra instructions for agents at each stage. Keep this section below the settings above.
# [instructions]
# implementation = ["Keep changes small and match the surrounding code."]
# validation = []
# review = ["Flag any change to the public API."]

# Files in this repository whose contents are given to agents as instructions, by stage.
# [instructionFiles]
# implementation = ["docs/CONTRIBUTING.md"]
# validation = []
# review = []

# How PR watch merges published pull requests and how patient it is with CI. mergeWith is
# "auto-merge" (GitHub's own), "queue-label" (add queueLabel; blockedLabel is the label the queue
# adds when it kicks a pull request out), or "off". Until mergeWith is set, PR watch retries CI
# but never merges; Tandem offers to set it up the first time it watches one of your pull
# requests here.
# [merging]
# mergeWith = "queue-label"
# queueLabel = "mergequeue"
# blockedLabel = "blocked"
# maxCiRetries = 1
# stuckAfterMinutes = 60

# Use a different model for one role in this project only. Roles: coordinator, scout,
# implementer, reviewer, presentation. Other roles keep your saved choices.
# [models.implementer]
# model = "provider/model"
# thinking = "high"
`;
}

const NO_CHECKS_LINE = 'validation = "none"';
