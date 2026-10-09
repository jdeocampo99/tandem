import { expect, test } from "bun:test";
import { CliUsageError } from "../../src/terminal/cli-argument-values.ts";
import { parseCliArgs } from "../../src/terminal/cli-arguments.ts";

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
