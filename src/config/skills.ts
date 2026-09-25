import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_SKILL_NAME_CHARS, MAX_TASK_SKILLS_BYTES, type SkillInvocation } from "../contracts.ts";
import { skillInstructionBytes } from "../tasks/skill-invocation.ts";
import { isNotFoundError } from "./storage.ts";

export type SkillSearch = Readonly<{
  /** Committed checkout of the repository the task works in; its skills win over personal ones. */
  readonly repositoryCheckout: string;
  /** The user's home folder, whose skill folders hold their personal skills. */
  readonly personalHome: string;
}>;

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

/**
 * Finds each named skill and reads its SKILL.md in full; a repository skill wins over a personal
 * one with the same name. Every failure is a message the coordinator can put to the user.
 */
export async function findSkills(
  names: readonly string[],
  search: SkillSearch,
): Promise<readonly SkillInvocation[]> {
  const skills: SkillInvocation[] = [];
  for (const name of new Set(names.map(skillName))) {
    skills.push(await findSkill(name, search));
  }
  const bytes = skillInstructionBytes(skills);
  if (bytes > MAX_TASK_SKILLS_BYTES) {
    throw new Error(
      `The skills ${skills.map((skill) => skill.name).join(", ")} are ${kilobytes(bytes)} KB together; a task can carry at most ${kilobytes(MAX_TASK_SKILLS_BYTES)} KB of skills. Ask the user which to leave out.`,
    );
  }
  return skills;
}

/** Accepts the name as the user typed it, with or without the `/skill:` prefix. */
function skillName(value: string): string {
  const name = value.trim().replace(/^\/?skill:/u, "");
  if (name.length > MAX_SKILL_NAME_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new Error(`"${value}" is not a skill name; skill names are folder names like tdd.`);
  }
  return name;
}

async function findSkill(name: string, search: SkillSearch): Promise<SkillInvocation> {
  const repository = await skillFolders(search.repositoryCheckout, REPOSITORY_SKILL_FOLDERS, name);
  const personal =
    repository.length > 0
      ? []
      : await skillFolders(search.personalHome, PERSONAL_SKILL_FOLDERS, name);
  const origin = repository.length > 0 ? "repository" : "personal";
  const found = repository.length > 0 ? repository : personal;
  const [directory, ...others] = found;
  if (directory === undefined) {
    throw new Error(
      `No skill named ${name} in this repository or the user's personal skills. Ask the user which skill they meant.`,
    );
  }
  if (others.length > 0) {
    throw new Error(
      `Different skills are named ${name}: ${found.join(" and ")}. Ask the user which one to use.`,
    );
  }
  const instructions = withoutFrontmatter(await readFile(join(directory, "SKILL.md"), "utf8"));
  if (instructions.length === 0) {
    throw new Error(`The skill ${name} at ${directory} has no instructions.`);
  }
  return { name, origin, directory, instructions };
}

/** The distinct real folders under `root` holding `<name>/SKILL.md`; a linked copy counts once. */
async function skillFolders(
  root: string,
  folders: readonly string[],
  name: string,
): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const folder of folders) {
    try {
      found.add(dirname(await realpath(join(root, folder, name, "SKILL.md"))));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return [...found];
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
}

function kilobytes(bytes: number): number {
  return Math.ceil(bytes / 1024);
}
