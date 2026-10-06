import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The process calling native owns its immutable input until that one invocation has settled. */
export async function withNativePrInput<T>(
  input: string,
  invoke: (path: string) => Promise<T>,
): Promise<T> {
  // Reject malformed input before creating any files. The native CLI validates the domain shape.
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Native PR input must be a JSON object");
  const directory = await mkdtemp(join(tmpdir(), "tandem-native-pr-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, input, { flag: "wx", mode: 0o600 });
    return await invoke(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const [verb, id, ...context] = Bun.argv.slice(2);
    if (verb !== "pr-comment" && verb !== "review-submit")
      throw new TypeError("Unknown native PR input action");
    if (id === undefined || !/^[A-Za-z0-9_-]+$/u.test(id))
      throw new TypeError("Native PR action requires a task id");
    const code = await withNativePrInput(await Bun.stdin.text(), async (path) => {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../main.ts", import.meta.url).pathname,
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
