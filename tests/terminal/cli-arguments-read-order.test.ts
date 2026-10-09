import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import { CliUsageError } from "../../src/terminal/cli-argument-values.ts";
import { parseCliArgs } from "../../src/terminal/cli-arguments.ts";
import { modelAssignmentsFromFile } from "../../src/terminal/cli-input.ts";

test("CLI parsing reads a getter-backed positional once", () => {
  let reads = 0;
  const argv: readonly string[] = ["show", "task-id"];
  Object.defineProperty(argv, "1", {
    get(): string {
      reads += 1;
      if (reads > 1) throw new Error("positional read twice");
      return "task-id";
    },
  });
  Object.freeze(argv);

  const invocation = parseCliArgs(argv);

  expect(invocation.command).toBe("show");
  expect(invocation.positionals).toEqual(["task-id"]);
  expect(reads).toBe(1);
});

test("CLI parsing rejects an unknown command before reading the next getter", () => {
  let reads = 0;
  const argv: readonly string[] = ["unknown", "task-id"];
  Object.defineProperty(argv, "1", {
    get(): string {
      reads += 1;
      throw new Error("next argument read before command rejection");
    },
  });
  Object.freeze(argv);

  expect(() => parseCliArgs(argv)).toThrow(new CliUsageError('unknown Tandem command "unknown"'));
  expect(reads).toBe(0);
});

test("model input resolves relative paths and waits for stat before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-model-input-"));
  try {
    const inputPath = join(root, " models.json ");
    const models = defaultPolicy().models;
    const calls: string[] = [];
    const loaded = await modelAssignmentsFromFile(
      async (path) => {
        calls.push(path);
        await writeFile(path, JSON.stringify({ ...models, verifier: { legacy: true } }));
        return lstat(path);
      },
      relative(process.cwd(), inputPath),
    );

    expect(calls).toEqual([inputPath]);
    expect(loaded).toEqual(models);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [undefined, "input must be non-empty text"],
  [null, "input must be non-empty text"],
  [42, "input must be non-empty text"],
  ["", "input must be non-empty text"],
  [" ", "input must be non-empty text"],
  ["models\0.json", "input must not contain NUL characters"],
  ["models\n.json", "input must not contain control characters"],
])("model input rejects invalid path %p before stat", async (file, message) => {
  const calls: string[] = [];
  const statPath = async (path: string) => {
    calls.push(path);
    return lstat(path);
  };
  const result = Reflect.apply(modelAssignmentsFromFile, undefined, [statPath, file]);

  await expect(result).rejects.toBeInstanceOf(CliUsageError);
  await expect(result).rejects.toThrow(message);
  expect(calls).toEqual([]);
});

test.each([new Error("stat blocked"), "stat blocked"])(
  "model input preserves plain stat errors for %p",
  async (failure) => {
    const inputPath = resolve("unavailable-model-input.json");
    const result = modelAssignmentsFromFile(() => Promise.reject(failure), inputPath);

    await expect(result).rejects.toHaveProperty("constructor", Error);
    await expect(result).rejects.toThrow(`input is unavailable at ${inputPath}: stat blocked`);
  },
);

test("model input rejects directories and symlinks before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-model-input-"));
  try {
    const inputPath = join(root, "models.json");
    const link = join(root, "model-link.json");
    await writeFile(inputPath, JSON.stringify(defaultPolicy().models));
    await symlink(inputPath, link);

    for (const path of [root, link]) {
      const result = modelAssignmentsFromFile(lstat, path);
      await expect(result).rejects.toHaveProperty("constructor", Error);
      await expect(result).rejects.toThrow(`input must be a regular non-symlink file: ${path}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model input translates a read failure after a successful stat", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-model-input-"));
  try {
    const inputPath = join(root, "missing.json");
    const readError = await readFile(inputPath, "utf8").catch((error: unknown) => error);
    expect(readError).toBeInstanceOf(Error);
    if (!(readError instanceof Error)) throw new Error("expected a read failure");
    const calls: string[] = [];
    const result = modelAssignmentsFromFile(async (path) => {
      calls.push(path);
      return lstat(import.meta.filename);
    }, inputPath);

    await expect(result).rejects.toBeInstanceOf(CliUsageError);
    await expect(result).rejects.toThrow(
      `input is unavailable at ${inputPath}: ${readError.message}`,
    );
    expect(calls).toEqual([inputPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["{", /^input must be valid JSON: /],
  ["[]", "input must be a JSON object"],
  ["null", "input must be a JSON object"],
  [
    "{}",
    'input must contain a complete model assignment map: models must contain role "coordinator"',
  ],
  [
    JSON.stringify({ ...defaultPolicy().models, coordinator: {} }),
    "input must contain a complete model assignment map: models.coordinator must contain model and thinking",
  ],
])("model input preserves JSON and assignment errors for %s", async (source, message) => {
  const root = await mkdtemp(join(tmpdir(), "tandem-cli-model-input-"));
  try {
    const inputPath = join(root, "models.json");
    await writeFile(inputPath, source);
    const result = modelAssignmentsFromFile(lstat, inputPath);

    await expect(result).rejects.toBeInstanceOf(CliUsageError);
    await expect(result).rejects.toThrow(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
