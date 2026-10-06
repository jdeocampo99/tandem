import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The process calling native owns its immutable input until that one invocation has settled. */
export async function withNativeInput<T>(
  input: string,
  invoke: (path: string) => Promise<T>,
): Promise<T> {
  // Reject malformed input before creating any files. The native CLI validates the domain shape.
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Native action input must be a JSON object");
  const directory = await mkdtemp(join(tmpdir(), "tandem-native-input-"));
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
    if (
      verb === undefined ||
      ![
        "brief-comment",
        "brief-request-changes",
        "brief-approve",
        "pr-comment",
        "review-submit",
      ].includes(verb)
    )
      throw new TypeError("Unknown native JSON input action");
    if (id === undefined || !/^[A-Za-z0-9_-]+$/u.test(id))
      throw new TypeError("Native action requires a task or request id");
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
