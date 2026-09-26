import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSkills,
  frontmatterDescription,
  listPluginSkills,
  listSkillCatalog,
} from "../../src/config/skills.ts";
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

/** Records one installed Claude Code plugin per key, the way Claude Code's install file does. */
async function installPlugins(
  personalHome: string,
  plugins: Readonly<Record<string, string>>,
): Promise<void> {
  const record = Object.fromEntries(
    Object.entries(plugins).map(([key, installPath]) => [key, [{ scope: "user", installPath }]]),
  );
  await mkdir(join(personalHome, ".claude", "plugins"), { recursive: true });
  await writeFile(
    join(personalHome, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: record }),
  );
}

test("finds a skill a Claude Code plugin ships and pins its folder", async () => {
  await withSkillFolders(async (search) => {
    const install = join(search.personalHome, "cache", "buildkite", "1.0.0");
    await writeSkill(join(install, "skills", "logs"), "---\nname: logs\n---\nRead the build log.");
    await installPlugins(search.personalHome, { "buildkite@market": install });
    const [skill] = await findSkills(["logs"], search);
    expect(skill).toEqual({
      name: "logs",
      origin: "personal",
      directory: await realpath(join(install, "skills", "logs")),
      instructions: "Read the build log.",
    });
  });
});

test("plugin:name picks that plugin's skill and a bare name matching two plugins is refused", async () => {
  await withSkillFolders(async (search) => {
    const first = join(search.personalHome, "cache", "codex");
    const second = join(search.personalHome, "cache", "other");
    await writeSkill(join(first, "skills", "rescue"), "Codex rescue.");
    await writeSkill(join(second, "skills", "rescue"), "Other rescue.");
    await installPlugins(search.personalHome, { "codex@openai": first, "other@market": second });

    const [skill] = await findSkills(["codex:rescue"], search);
    expect(skill?.name).toBe("codex:rescue");
    expect(skill?.instructions).toBe("Codex rescue.");
    await expect(findSkills(["rescue"], search)).rejects.toThrow(
      "Different skills are named rescue",
    );
    await expect(findSkills(["codex:missing"], search)).rejects.toThrow(
      "No skill named missing in the user's codex plugin",
    );
  });
});

test("plugin skills count toward the size limit and a name given twice counts once", async () => {
  await withSkillFolders(async (search) => {
    const install = join(search.personalHome, "cache", "big");
    const half = "x".repeat(MAX_TASK_SKILLS_BYTES / 2 + 1);
    await writeSkill(join(install, "skills", "big"), half);
    await writeSkill(join(search.personalHome, ".claude", "skills", "bigger"), half);
    await installPlugins(search.personalHome, { "big@market": install });
    expect(await findSkills(["big", "big:big", "/skill:big"], search)).toHaveLength(1);
    await expect(findSkills(["big:big", "bigger"], search)).rejects.toThrow(
      "The skills big:big, bigger are 33 KB together",
    );
  });
});

test("lists the skills plugins ship, qualified by plugin only when two share a name", async () => {
  await withSkillFolders(async (search) => {
    const codex = join(search.personalHome, "cache", "codex");
    const other = join(search.personalHome, "cache", "other");
    await writeSkill(join(codex, "skills", "rescue"), "Codex rescue.");
    await writeSkill(join(codex, "skills", "buildkite"), "Read builds.");
    await writeSkill(join(other, "skills", "rescue"), "Other rescue.");
    await installPlugins(search.personalHome, { "codex@openai": codex, "other@market": other });
    expect(await listPluginSkills(search.personalHome)).toEqual([
      "buildkite",
      "codex:rescue",
      "other:rescue",
    ]);
  });
});

test("the setup page lists personal and plugin skills by the name that finds each alone", async () => {
  await withSkillFolders(async (search) => {
    await writeSkill(
      join(search.personalHome, ".claude", "skills", "tdd"),
      "---\nname: tdd\ndescription: Write the failing test first\n---\nBody.",
    );
    await writeSkill(join(search.personalHome, ".agents", "skills", "tdd"), "Another tdd.");
    await writeSkill(join(search.personalHome, ".omp", "agent", "skills", "notes"), "No front.");
    await writeSkill(join(search.repositoryCheckout, ".claude", "skills", "repo-only"), "Repo.");
    const ci = join(search.personalHome, "cache", "ci");
    await writeSkill(join(ci, "skills", "tdd"), "Plugin tdd.");
    await writeSkill(
      join(ci, "skills", "buildkite"),
      "---\ndescription: >\n  Read CI runs\n  and failing logs\n---\n",
    );
    await installPlugins(search.personalHome, { "ci@market": ci });
    expect(await listSkillCatalog(search.personalHome)).toEqual([
      { name: "notes", source: "~/.omp/agent/skills", description: "" },
      { name: "tdd", source: "~/.claude/skills", description: "Write the failing test first" },
      { name: "buildkite", source: "plugin: ci", description: "Read CI runs and failing logs" },
      { name: "ci:tdd", source: "plugin: ci", description: "" },
    ]);
  });
});

test("skill descriptions are one line, unquoted, and cut at a word", () => {
  expect(frontmatterDescription('---\ndescription: "Quoted: yes"\n---\n')).toBe("Quoted: yes");
  expect(frontmatterDescription("---\ndescription: 'It''s fine'\n---\n")).toBe("It's fine");
  expect(frontmatterDescription("no frontmatter")).toBe("");
  const long = frontmatterDescription(`---\ndescription: ${"word ".repeat(60)}\n---\n`);
  expect(long.length).toBeLessThanOrEqual(140);
  expect(long).toEndWith("word…");
});
