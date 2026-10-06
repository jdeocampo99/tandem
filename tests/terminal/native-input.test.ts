import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { withNativePrInput } from "../../src/terminal/native-pr-input.ts";

test("concurrent PR actions keep private distinct immutable inputs until each child finishes", async () => {
  const seen: string[] = [];
  const input = JSON.stringify({
    comments: [{ file: "file with spaces.ts", line: 12, text: "日本語 😀 `$(echo secret)`" }],
  });
  await Promise.all(
    [1, 2].map(() =>
      withNativePrInput(input, async (path) => {
        seen.push(path);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        expect(await readFile(path, "utf8")).toBe(input);
        await Bun.sleep(5);
        expect(await readFile(path, "utf8")).toBe(input);
      }),
    ),
  );
  expect(new Set(seen).size).toBe(2);
  for (const path of seen) expect(await Bun.file(path).exists()).toBe(false);
});

test("PR action cleanup also runs on a refused or failed invocation without retry", async () => {
  let path = "";
  let count = 0;
  await expect(
    withNativePrInput("{}", async (created) => {
      path = created;
      count++;
      throw new Error("unknown outcome");
    }),
  ).rejects.toThrow("unknown outcome");
  expect(count).toBe(1);
  expect(await Bun.file(path).exists()).toBe(false);
});
