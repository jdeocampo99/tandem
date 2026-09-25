import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_SKILL_NAME_CHARS, MAX_TASK_SKILLS_BYTES, type SkillInvocation } from "../contracts.ts";
import { skillInstructionBytes } from "../tasks/skill-invocation.ts";
import { isNotFoundError } from "./storage.ts";
import { isRecord } from "./values.ts";

export type SkillSearch = Readonly<{
  /** Committed checkout of the repository the task works in; its skills win over personal ones. */
  readonly repositoryCheckout: string;
  /** The user's home folder, whose skill folders and Claude Code plugins hold their personal skills. */
  readonly personalHome: string;
}>;

/** A skill as the user named it: a folder name, optionally qualified by the plugin it ships in. */
type SkillName = Readonly<{
  readonly spelling: string;
  readonly name: string;
  readonly plugin?: string;
}>;

type FoundSkill = Extract<SkillInvocation, { readonly directory: string }>;

// The folders OMP loads skills from, relative to a repository root and to the user's home.
const REPOSITORY_SKILL_FOLDERS = [
  ".omp/skills",
  ".claude/skills",
  ".agents/skills",
  ".agent/skills",
  ".codex/skills",
] as const;
const PERSONAL_SKILL_FOLDERS = [
  ".omp/agent/skills",
  ".claude/skills",
  ".agents/skills",
  ".agent/skills",
  ".codex/skills",
] as const;
/** Claude Code's record of installed plugins; each install ships skills under `skills/<name>`. */
const CLAUDE_PLUGINS_FILE = ".claude/plugins/installed_plugins.json";
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Finds each named skill and reads its SKILL.md in full; a repository skill wins over a personal
 * one with the same name. Names that lead to the same folder count once. Every failure is a
 * message the coordinator can put to the user.
 */
export async function findSkills(
  names: readonly string[],
  search: SkillSearch,
): Promise<readonly SkillInvocation[]> {
  const skills: FoundSkill[] = [];
  const named = new Map(names.map(skillName).map((name) => [name.spelling, name]));
  for (const name of named.values()) {
    const skill = await findSkill(name, search);
    if (!skills.some((found) => found.directory === skill.directory)) {
      skills.push(skill);
    }
  }
  const bytes = skillInstructionBytes(skills);
  if (bytes > MAX_TASK_SKILLS_BYTES) {
    throw new Error(
      `The skills ${skills.map((skill) => skill.name).join(", ")} are ${kilobytes(bytes)} KB together; a task can carry at most ${kilobytes(MAX_TASK_SKILLS_BYTES)} KB of skills. Ask the user which to leave out.`,
    );
  }
  return skills;
}

/** Accepts the name as the user typed it, with or without the `/skill:` prefix, and `plugin:name`. */
function skillName(value: string): SkillName {
  const spelling = value.trim().replace(/^\/?skill:/u, "");
  const parts = spelling.split(":");
  const [first, second] = parts;
  const valid =
    spelling.length <= MAX_SKILL_NAME_CHARS &&
    parts.length <= 2 &&
    parts.every((part) => FOLDER_NAME.test(part));
  if (!valid || first === undefined) {
    throw new Error(
      `"${value}" is not a skill name; skill names are folder names like tdd, or plugin:name for a plugin's skill.`,
    );
  }
  return second === undefined
    ? { spelling, name: first }
    : { spelling, name: second, plugin: first };
}

async function findSkill(skill: SkillName, search: SkillSearch): Promise<FoundSkill> {
  const repository =
    skill.plugin === undefined
      ? await skillFolders(search.repositoryCheckout, REPOSITORY_SKILL_FOLDERS, skill.name)
      : [];
  const personal =
    repository.length > 0
      ? []
      : [
          ...(skill.plugin === undefined
            ? await skillFolders(search.personalHome, PERSONAL_SKILL_FOLDERS, skill.name)
            : []),
          ...(await pluginSkillFolders(search.personalHome, skill)),
        ];
  const origin = repository.length > 0 ? "repository" : "personal";
  const found = repository.length > 0 ? repository : [...new Set(personal)];
  const [directory, ...others] = found;
  if (directory === undefined) {
    throw new Error(
      skill.plugin === undefined
        ? `No skill named ${skill.name} in this repository or the user's personal skills. Ask the user which skill they meant.`
        : `No skill named ${skill.name} in the user's ${skill.plugin} plugin. Ask the user which skill they meant.`,
    );
  }
  if (others.length > 0) {
    throw new Error(
      `Different skills are named ${skill.spelling}: ${found.join(" and ")}. Ask the user which one to use.`,
    );
  }
  const instructions = withoutFrontmatter(await readFile(join(directory, "SKILL.md"), "utf8"));
  if (instructions.length === 0) {
    throw new Error(`The skill ${skill.spelling} at ${directory} has no instructions.`);
  }
  return { name: skill.spelling, origin, directory, instructions };
}

/** The distinct real folders under `root` holding `<name>/SKILL.md`; a linked copy counts once. */
async function skillFolders(
  root: string,
  folders: readonly string[],
  name: string,
): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const folder of folders) {
    const directory = await realSkillFolder(join(root, folder, name));
    if (directory !== undefined) found.add(directory);
  }
  return [...found];
}

/**
 * The skill's folder in each installed Claude Code plugin that ships it, limited to the named plugin
 * when there is one. A plugin is named by its key in the install record, without `@marketplace`.
 */
async function pluginSkillFolders(
  personalHome: string,
  skill: SkillName,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const install of await installedPlugins(personalHome)) {
    if (skill.plugin !== undefined && install.plugin !== skill.plugin) continue;
    const directory = await realSkillFolder(join(install.path, "skills", skill.name));
    if (directory !== undefined) found.push(directory);
  }
  return found;
}

async function installedPlugins(
  personalHome: string,
): Promise<readonly Readonly<{ plugin: string; path: string }>[]> {
  let text: string;
  try {
    text = await readFile(join(personalHome, CLAUDE_PLUGINS_FILE), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const record: unknown = JSON.parse(text);
  const plugins = isRecord(record) && isRecord(record.plugins) ? record.plugins : {};
  return Object.entries(plugins).flatMap(([key, installs]) =>
    (Array.isArray(installs) ? installs : []).flatMap((install: unknown) =>
      isRecord(install) && typeof install.installPath === "string"
        ? [{ plugin: key.split("@")[0] ?? key, path: install.installPath }]
        : [],
    ),
  );
}

async function realSkillFolder(folder: string): Promise<string | undefined> {
  try {
    return dirname(await realpath(join(folder, "SKILL.md")));
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
}

function kilobytes(bytes: number): number {
  return Math.ceil(bytes / 1024);
}
