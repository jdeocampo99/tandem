import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run the standalone Luau CLI, with no Tern daemon, window or live Tandem state.
const luau = process.env.TANDEM_LUAU_BINARY ?? Bun.which("luau");
(luau ? test : test.skip)(
  "PR actions retain drafts on failure and only close for a posted receipt",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tandem-pr-luau-"));
    try {
      let source =
        "local tern = {}\nlocal modules = {}\nlocal cache = {}\nlocal function loadModule(name)\nif cache[name] == nil then cache[name] = modules[name]() end\nreturn cache[name]\nend\n";
      for (const name of [
        "view-file",
        "navigation",
        "components",
        "text-field",
        "diff-row",
        "pr-model",
        "pr-diff",
        "pr-content",
        "pr",
      ]) {
        const module = await readFile(
          fileURLToPath(new URL(`../../tern-plugin/${name}.luau`, import.meta.url)),
          "utf8",
        );
        source += `modules["./${name}"] = function()\n${module.replaceAll("require(", "loadModule(")}\nend\n`;
      }
      source += await readFile(
        fileURLToPath(new URL("./tern-pr-actions.luau", import.meta.url)),
        "utf8",
      );
      const path = join(root, "actions.luau");
      await writeFile(path, source);
      const child = Bun.spawn([luau as string, path], { stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status, stderr).toBe(0);
      expect(stdout).toContain(
        "PR action result, home forwarding and draft retention checks passed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
