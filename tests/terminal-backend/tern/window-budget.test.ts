import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { luauBinary } from "../../luau.ts";

test("window hooks defer cold imports and serialize one process launch per callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-host-luau-"));
  try {
    const window = await readFile(
      new URL("../../../tern-plugin/window.luau", import.meta.url),
      "utf8",
    );
    const navigation = await readFile(
      new URL("../../../tern-plugin/navigation.luau", import.meta.url),
      "utf8",
    );
    const checks = await readFile(new URL("./window-budget.luau", import.meta.url), "utf8");
    const path = join(root, "window.luau");
    await writeFile(
      path,
      checks.replace(
        "-- ENTRY_POINT",
        `loadNavigation=function()\n${navigation}\nend\ndo\n${window.replaceAll("require(", "loadModule(")}\nend`,
      ),
    );
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("Every window hook path stays below 50 ms");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
