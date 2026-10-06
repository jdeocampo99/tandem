import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeViewPath, writeNativeView } from "../../src/tern-view/file.ts";

test("replacing a native view publishes its complete revision with private permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-view-"));
  try {
    const first = {
      version: 1 as const,
      kind: "brief" as const,
      revision: "rev-1",
      model: { title: "Before" },
    };
    const path = await writeNativeView(home, first, "request-1");
    await writeNativeView(
      home,
      { ...first, revision: "rev-2", model: { title: "After" } },
      "request-1",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...first,
      revision: "rev-2",
      model: { title: "After" },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(() => nativeViewPath(home, "brief", "../escape")).toThrow("invalid native view");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
