import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpecialists } from "../../src/specialists/registry.ts";
import { renderSpecialistList } from "../../src/specialists/view.ts";

test("the list names every specialist and reports each broken file once by its repository path", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-specialists-view-"));
  try {
    const repositoryCheckout = join(root, "repo");
    const folder = join(repositoryCheckout, ".tandem", "specialists");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "seo.md"), "---\nname: seo\nmodel: x\n---\nBody");
    await writeFile(join(folder, "blog-writer.md"), "---\nname: blog-writer\n---\nBody");
    const registry = await loadSpecialists({ repositoryCheckout, tandemHome: join(root, "home") });
    const text = renderSpecialistList(registry, "site");
    for (const name of [
      "blog-writer",
      "bug-fix",
      "feature",
      "general",
      "perf",
      "refactor",
      "seo",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain(join(".tandem", "specialists", "seo.md"));
    expect(text).not.toContain(join(folder, "seo.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
