import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uncertainPostMessage } from "../../src/pr-review/render.ts";
import { luauBinary } from "../luau.ts";

// Run the standalone Luau CLI, with no Tern daemon, window or live Tandem state.
test("PR and embedded task actions retain drafts on failure and require a posted receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-pr-luau-"));
  try {
    let source =
      "local tern = {}\nlocal modules = {}\nlocal cache = {}\nlocal function loadModule(name)\nif cache[name] == nil then cache[name] = modules[name]() end\nreturn cache[name]\nend\n";
    for (const name of [
      "rt",
      "components",
      "text-field",
      "diff-row",
      "pr-model",
      "pr-diff",
      "pr-content",
      "pr",
      "task",
    ]) {
      const module = await readFile(
        fileURLToPath(new URL(`../../tern-plugin/${name}.luau`, import.meta.url)),
        "utf8",
      );
      source += `modules["./${name}"] = function()\n${module.replaceAll("require(", "loadModule(")}\nend\n`;
    }
    const uncertainMessage = uncertainPostMessage(
      "https://github.com/acme/app/pull/281",
      "GitHub response was lost.",
    );
    source += `local uncertainMessage = ${JSON.stringify(uncertainMessage)}\nlocal uncertainOutput = ${JSON.stringify(JSON.stringify({ status: "kept", notice: { code: "review-unconfirmed", text: uncertainMessage } }))}\n`;
    source += await readFile(
      fileURLToPath(new URL("./tern-pr-actions.luau", import.meta.url)),
      "utf8",
    );
    source += await readFile(
      fileURLToPath(new URL("../tasks/tern-task-actions.luau", import.meta.url)),
      "utf8",
    );
    const path = join(root, "actions.luau");
    await writeFile(path, source);
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("PR action result, context echo and draft retention checks passed");
    expect(stdout).toContain("Embedded task review completion checks passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
