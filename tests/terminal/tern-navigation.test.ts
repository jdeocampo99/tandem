import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { luauBinary } from "../luau.ts";

test("native navigation completes catch-up warning entries and preserves retained or unknown views", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-navigation-luau-"));
  try {
    const navigation = await readFile(
      new URL("../../tern-plugin/navigation.luau", import.meta.url),
      "utf8",
    );
    const scenario = await readFile(new URL("./tern-navigation.luau", import.meta.url), "utf8");
    const path = join(root, "navigation.luau");
    await writeFile(
      path,
      `local tern = {}\nlocal function loadNavigation()\n${navigation}\nend\n${scenario}`,
    );
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("Navigation warning callback checks passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
