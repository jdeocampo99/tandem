import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeHomeSpecialist } from "../../src/specialists/home-files.ts";
import { loadSpecialists, specialistFileRevision } from "../../src/specialists/registry.ts";
import { type SpecialistFields, specialistFields } from "../../src/specialists/specialist.ts";

const FIELDS: SpecialistFields = {
  label: "SEO blog post",
  description: "A blog post that has to rank",
  instructions: "Write for a reader who searched.",
  steps: ["Pick the keyword", "Draft"],
};

async function withHome(run: (home: string, root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-home-files-")));
  try {
    const home = join(root, "home");
    await mkdir(home);
    await run(home, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function revisionOf(path: string): Promise<string> {
  return specialistFileRevision(await readFile(path));
}

/** Every file under `root`, relative, so a test can see nothing landed anywhere else. */
async function tree(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

test("a created file loads back as the same specialist from Just me", async () => {
  await withHome(async (home) => {
    const { path } = await changeHomeSpecialist(home, {
      op: "create",
      name: "seo-blog",
      fields: FIELDS,
    });
    expect(path).toBe(join(home, "specialists", "seo-blog.md"));
    const registry = await loadSpecialists({
      repositoryCheckout: join(home, "none"),
      tandemHome: home,
    });
    const file = registry.files.find((entry) => entry.name === "seo-blog");
    expect(file?.origin).toBe("home");
    expect(file?.revision).toBe(await revisionOf(path));
    if (!file?.result.valid) throw new Error("the written file did not load");
    expect(specialistFields(file.result.specialist)).toEqual(FIELDS);
  });
});

test("a create never replaces a file with that name", async () => {
  await withHome(async (home) => {
    await changeHomeSpecialist(home, { op: "create", name: "seo-blog", fields: FIELDS });
    const before = await readFile(join(home, "specialists", "seo-blog.md"), "utf8");
    await expect(
      changeHomeSpecialist(home, {
        op: "create",
        name: "seo-blog",
        fields: { ...FIELDS, label: "Other" },
      }),
    ).rejects.toThrow("Just me already has seo-blog");
    expect(await readFile(join(home, "specialists", "seo-blog.md"), "utf8")).toBe(before);
    expect(await tree(home)).toEqual(["specialists/seo-blog.md"]);
  });
});

test("an update or remove of a file that changed since it was shown is refused", async () => {
  await withHome(async (home) => {
    const { path } = await changeHomeSpecialist(home, {
      op: "create",
      name: "seo-blog",
      fields: FIELDS,
    });
    const shown = await revisionOf(path);
    await writeFile(path, "---\nname: seo-blog\n---\nEdited by hand.\n");
    await expect(
      changeHomeSpecialist(home, {
        op: "update",
        name: "seo-blog",
        revision: shown,
        fields: { ...FIELDS, label: "Mine" },
      }),
    ).rejects.toThrow("seo-blog changed on disk since Settings showed it");
    await expect(
      changeHomeSpecialist(home, { op: "remove", name: "seo-blog", revision: shown }),
    ).rejects.toThrow("changed on disk");
    expect(await readFile(path, "utf8")).toContain("Edited by hand.");
  });
});

test("an update with the shown revision replaces the file", async () => {
  await withHome(async (home) => {
    const { path } = await changeHomeSpecialist(home, {
      op: "create",
      name: "seo-blog",
      fields: FIELDS,
    });
    await changeHomeSpecialist(home, {
      op: "update",
      name: "seo-blog",
      revision: await revisionOf(path),
      fields: { ...FIELDS, steps: ["Draft"] },
    });
    expect(await readFile(path, "utf8")).not.toContain("Pick the keyword");
  });
});

test("remove deletes only the named file", async () => {
  await withHome(async (home) => {
    const kept = await changeHomeSpecialist(home, { op: "create", name: "keep", fields: FIELDS });
    const gone = await changeHomeSpecialist(home, { op: "create", name: "gone", fields: FIELDS });
    await writeFile(join(home, "specialists", "notes.txt"), "mine");
    await changeHomeSpecialist(home, {
      op: "remove",
      name: "gone",
      revision: await revisionOf(gone.path),
    });
    expect(await tree(home)).toEqual(["specialists/keep.md", "specialists/notes.txt"]);
    expect(await readFile(kept.path, "utf8")).toContain("SEO blog post");
  });
});

test("a specialists folder that links elsewhere is read-only", async () => {
  await withHome(async (home, root) => {
    const dotfiles = join(root, "dotfiles", "specialists");
    await mkdir(dotfiles, { recursive: true });
    await symlink(dotfiles, join(home, "specialists"));
    await expect(
      changeHomeSpecialist(home, { op: "create", name: "seo-blog", fields: FIELDS }),
    ).rejects.toThrow("is a link to another folder");
    expect(await readdir(dotfiles)).toEqual([]);
  });
});

test("names that would leave the folder, and the reserved name, are refused before any write", async () => {
  await withHome(async (home, root) => {
    for (const name of ["../escape", "a/b", "fix-round", "Upper"]) {
      await expect(
        changeHomeSpecialist(home, { op: "create", name, fields: FIELDS }),
      ).rejects.toThrow();
    }
    await expect(
      changeHomeSpecialist(home, {
        op: "create",
        name: "bad-fields",
        fields: { ...FIELDS, instructions: "```\nopen fence" },
      }),
    ).rejects.toThrow("bad-fields: ");
    expect(await tree(root)).toEqual([]);
  });
});
