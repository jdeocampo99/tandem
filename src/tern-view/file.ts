import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NativeViewKind = "panel" | "task" | "brief" | "pr" | "board" | "usage" | "catch-up";

/** Derived presentation data. Revision is carried back by actions that need a stale-view guard. */
export type NativeViewFile<Model> = Readonly<{
  version: 1;
  kind: NativeViewKind;
  revision: string;
  model: Model;
}>;

export function nativeViewPath(home: string, kind: NativeViewKind, key = "current"): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(key)) throw new Error("invalid native view file key");
  return join(home, "views", `${kind}-${key}.tandem-view.json`);
}

/** One writer per destination; readers see a complete old or new revision. */
export async function writeNativeView<Model>(
  home: string,
  file: NativeViewFile<Model>,
  key = "current",
): Promise<string> {
  const path = nativeViewPath(home, file.kind, key);
  await mkdir(join(home, "views"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(file)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
