import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkills } from "../../src/config/skills.ts";
import { MAX_TASK_SKILLS_BYTES } from "../../src/contracts.ts";

async function withSkillFolders(
  run: (paths: { repositoryCheckout: string; personalHome: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-skills-"));
  try {
    await run({ repositoryCheckout: join(root, "repo"), personalHome: join(root, "home") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(directory: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), text);
}

test("refuses two different personal skills with the same name", async () => {
  await withSkillFolders(async (search) => {
    await writeSkill(join(search.personalHome, ".claude", "skills", "tdd"), "One.");
    await writeSkill(join(search.personalHome, ".agents", "skills", "tdd"), "Two.");
    await expect(findSkills(["tdd"], search)).rejects.toThrow("Different skills are named tdd");
  });
});

test("refuses a skill whose SKILL.md holds only frontmatter", async () => {
  await withSkillFolders(async (search) => {
    await writeSkill(
      join(search.repositoryCheckout, ".omp", "skills", "empty"),
      "---\nname: empty\n---\n",
    );
    await expect(findSkills(["empty"], search)).rejects.toThrow("has no instructions");
  });
});

test("refuses skills that together pass the size limit and names them", async () => {
  await withSkillFolders(async (search) => {
    const half = "x".repeat(MAX_TASK_SKILLS_BYTES / 2 + 1);
    await writeSkill(join(search.repositoryCheckout, ".claude", "skills", "big"), half);
    await writeSkill(join(search.repositoryCheckout, ".claude", "skills", "bigger"), half);
    expect(await findSkills(["big"], search)).toHaveLength(1);
    await expect(findSkills(["big", "bigger"], search)).rejects.toThrow(
      "The skills big, bigger are 33 KB together",
    );
  });
});
