import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const luau = process.env.TANDEM_LUAU_BINARY ?? Bun.which("luau");
(luau ? test : test.skip)(
  "plugin LOAD registers callbacks without requiring screens or doing effects",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tandem-load-guard-"));
    try {
      const entries = await Promise.all(
        ["host", "window"].map(async (name) => {
          const source = await readFile(
            fileURLToPath(new URL(`../../../tern-plugin/${name}.luau`, import.meta.url)),
            "utf8",
          );
          return `do\n${source.replaceAll("require(", "loadModule(")}\nend`;
        }),
      );
      const harness = await readFile(
        fileURLToPath(new URL("./plugin-load.luau", import.meta.url)),
        "utf8",
      );
      const path = join(root, "load.luau");
      await writeFile(path, harness.replace("-- ENTRY_POINTS", entries.join("\n")));
      const child = Bun.spawn([luau as string, path], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("Plugin LOAD is registration-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
