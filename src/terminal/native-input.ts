import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The process calling native owns its immutable input until that one invocation has settled. */
export async function withNativeInput<T>(
  input: string,
  invoke: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "tandem-native-input-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, input, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o400);
    return await invoke(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const [verb, id, ...context] = Bun.argv.slice(2);
    // The native CLI owns its verb allow-list, context and domain validation.
    if (verb === undefined || id === undefined)
      throw new TypeError("Native input caller requires a verb and positional id");
    const code = await withNativeInput(await Bun.stdin.text(), async (path) => {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../main.ts", import.meta.url)),
          "native",
          verb,
          id,
          "--input",
          path,
          ...context,
        ],
        { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      );
      return await child.exited;
    });
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
