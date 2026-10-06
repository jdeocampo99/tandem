import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { luauBinary } from "../../luau.ts";

test("native routes stage layout calls within fresh callback budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-host-luau-"));
  try {
    const module = await readFile(
      new URL("../../../tern-plugin/view-host.luau", import.meta.url),
      "utf8",
    );
    const checks = await readFile(new URL("./view-host.luau", import.meta.url), "utf8");
    const path = join(root, "host.luau");
    await writeFile(
      path,
      `local tern = {}\nlocal host = (function()\n${module}\nend)()\n${checks}`,
    );
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain(
      "Staged routes, second-project views, fresh contexts and quarantine checks passed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
