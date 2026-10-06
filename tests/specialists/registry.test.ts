import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecialistCandidate } from "../../src/specialists/classify.ts";
import {
  loadSpecialists,
  pinSpecialist,
  type SpecialistSearch,
} from "../../src/specialists/registry.ts";

async function withFolders(run: (search: SpecialistSearch) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-specialists-"));
  try {
    await run({ repositoryCheckout: join(root, "repo"), tandemHome: join(root, "home") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRepository(search: SpecialistSearch, name: string, text: string) {
  const folder = join(search.repositoryCheckout, ".tandem", "specialists");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.md`), text);
}

async function writeHome(search: SpecialistSearch, name: string, text: string) {
  const folder = join(search.tandemHome, "specialists");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.md`), text);
}

const noGuess = async () => undefined;

test("with no folders, the built-ins are ready and nothing is a problem", async () => {
  await withFolders(async (search) => {
    const registry = await loadSpecialists(search);
    expect(registry.problems).toEqual([]);
    expect(registry.entries.map((entry) => entry.status)).toEqual(Array(5).fill("ready"));
    expect((await pinSpecialist(registry, undefined, noGuess)).name).toBe("general");
  });
});

test("repository beats home beats built-in for the same name", async () => {
  await withFolders(async (search) => {
    await writeHome(search, "bug-fix", "---\nname: bug-fix\n---\nHome version.");
    await writeHome(search, "writer", "---\nname: writer\n---\nHome writer.");
    await writeRepository(search, "bug-fix", "---\nname: bug-fix\n---\nRepository version.");
    const registry = await loadSpecialists(search);
    const bugFix = await pinSpecialist(registry, "bug-fix", noGuess);
    expect(bugFix).toMatchObject({ origin: "repository", instructions: "Repository version." });
    expect(
      registry.entries.find(
        (entry) => entry.status === "ready" && entry.specialist.name === "bug-fix",
      )?.replaces,
    ).toEqual(["home", "built-in"]);
    expect(await pinSpecialist(registry, "writer", noGuess)).toMatchObject({ origin: "home" });
  });
});

test("a broken winning file blocks its name instead of falling through to the built-in", async () => {
  await withFolders(async (search) => {
    await writeHome(search, "bug-fix", "---\nname: bug-fix\n---\nHome version.");
    await writeRepository(search, "bug-fix", "---\nname: bug-fix\nmodel: opus\n---\nBody");
    const registry = await loadSpecialists(search);
    await expect(pinSpecialist(registry, "bug-fix", noGuess)).rejects.toThrow("bug-fix.md");
    await expect(pinSpecialist(registry, undefined, async () => "bug-fix")).resolves.toMatchObject({
      name: "general",
    });
    expect(registry.problems).toHaveLength(1);
  });
});

test("a specialist file that links outside its folder is broken", async () => {
  await withFolders(async (search) => {
    const outside = join(search.tandemHome, "secret.md");
    await mkdir(search.tandemHome, { recursive: true });
    await writeFile(outside, "---\nname: bug-fix\n---\nOutside text.");
    const folder = join(search.repositoryCheckout, ".tandem", "specialists");
    await mkdir(folder, { recursive: true });
    await symlink(outside, join(folder, "bug-fix.md"));
    const registry = await loadSpecialists(search);
    expect(registry.entries.find((entry) => entry.status === "broken")).toMatchObject({
      name: "bug-fix",
      problem: "points outside .tandem/specialists",
    });
    await expect(pinSpecialist(registry, "bug-fix", noGuess)).rejects.toThrow("bug-fix.md");
  });
});

test("a specialists folder that links outside the repository contributes nothing", async () => {
  await withFolders(async (search) => {
    const outside = join(search.tandemHome, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "bug-fix.md"), "---\nname: bug-fix\n---\nOutside text.");
    const folder = join(search.repositoryCheckout, ".tandem", "specialists");
    await mkdir(join(search.repositoryCheckout, ".tandem"), { recursive: true });
    await symlink(outside, folder);
    const registry = await loadSpecialists(search);
    expect(registry.problems).toEqual([{ path: folder, problem: "points outside the repository" }]);
    const bugFix = registry.entries.find(
      (entry) => entry.status === "ready" && entry.specialist.name === "bug-fix",
    );
    expect(bugFix).toMatchObject({ specialist: { origin: "built-in" } });
  });
});

test("a broken general fails every guess closed", async () => {
  await withFolders(async (search) => {
    await writeRepository(search, "general", "---\nname: general\n---\n");
    const registry = await loadSpecialists(search);
    await expect(pinSpecialist(registry, undefined, noGuess)).rejects.toThrow("general.md");
  });
});

test("bad file names, a name that differs from the file, and the reserved fix-round are problems", async () => {
  await withFolders(async (search) => {
    await writeHome(search, "Draft", "---\nname: Draft\n---\nBody");
    await writeRepository(search, "seo", "---\nname: search\n---\nBody");
    await writeRepository(search, "fix-round", "---\nname: fix-round\n---\nBody");
    const registry = await loadSpecialists(search);
    expect(registry.problems.map((problem) => problem.path?.split("/").at(-1)).sort()).toEqual([
      "Draft.md",
      "fix-round.md",
      "seo.md",
    ]);
    expect(
      registry.entries.some(
        (entry) => entry.status === "ready" && entry.specialist.name === "fix-round",
      ),
    ).toBe(false);
    await expect(pinSpecialist(registry, "seo", noGuess)).rejects.toThrow();
    await expect(pinSpecialist(registry, "fix-round", noGuess)).rejects.toThrow();
  });
});

test("a hidden broken file is still reported", async () => {
  await withFolders(async (search) => {
    await writeHome(search, "writer", "---\nname: writer\nmodel: x\n---\nBody");
    await writeRepository(search, "writer", "---\nname: writer\n---\nBody");
    const registry = await loadSpecialists(search);
    expect(await pinSpecialist(registry, "writer", noGuess)).toMatchObject({
      origin: "repository",
    });
    expect(registry.problems).toHaveLength(1);
  });
});

test("guessing offers only described specialists and ignores a pick outside them", async () => {
  await withFolders(async (search) => {
    await writeRepository(search, "silent", "---\nname: silent\n---\nBody");
    await writeRepository(search, "blog", "---\nname: blog\ndescription: Blog posts.\n---\nBody");
    const registry = await loadSpecialists(search);
    let offered: readonly SpecialistCandidate[] = [];
    const picked = await pinSpecialist(registry, undefined, async (candidates) => {
      offered = candidates;
      return "blog";
    });
    expect(picked.name).toBe("blog");
    expect(offered.map((candidate) => candidate.name)).toContain("blog");
    expect(offered.map((candidate) => candidate.name)).not.toContain("silent");
    expect((await pinSpecialist(registry, undefined, async () => "silent")).name).toBe("general");
  });
});

test("more described specialists than Jev can take disables guessing and is a problem", async () => {
  await withFolders(async (search) => {
    for (let index = 0; index < 60; index += 1) {
      await writeHome(
        search,
        `s${index}`,
        `---\nname: s${index}\ndescription: Kind ${index}.\n---\nBody`,
      );
    }
    const registry = await loadSpecialists(search);
    let asked = false;
    const picked = await pinSpecialist(registry, undefined, async () => {
      asked = true;
      return "s1";
    });
    expect(asked).toBe(false);
    expect(picked.name).toBe("general");
    expect(registry.problems).toHaveLength(1);
  });
});
