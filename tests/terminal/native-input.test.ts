import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { withNativeInput } from "../../src/terminal/native-input.ts";

test("concurrent PR and brief actions keep private distinct immutable inputs until each child finishes", async () => {
  const seen: string[] = [];
  const input = JSON.stringify({
    comments: [{ file: "file with spaces.ts", line: 12, text: "日本語 😀 `$(echo secret)`" }],
  });
  const approval = JSON.stringify({
    briefRevision: 3,
    contentDigest: "content",
    agreementDigest: "agreement",
  });
  await Promise.all(
    [input, approval].map((payload) =>
      withNativeInput(payload, async (path) => {
        seen.push(path);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        expect(await readFile(path, "utf8")).toBe(payload);
        await Bun.sleep(5);
        expect(await readFile(path, "utf8")).toBe(payload);
      }),
    ),
  );
  expect(new Set(seen).size).toBe(2);
  for (const path of seen) expect(await Bun.file(path).exists()).toBe(false);
});

test("Native action cleanup also runs on a refused or failed invocation without retry", async () => {
  let path = "";
  let count = 0;
  await expect(
    withNativeInput("{}", async (created) => {
      path = created;
      count++;
      throw new Error("unknown outcome");
    }),
  ).rejects.toThrow("unknown outcome");
  expect(count).toBe(1);
  expect(await Bun.file(path).exists()).toBe(false);
});

test("malformed native JSON never reaches an action", async () => {
  let calls = 0;
  for (const input of ["{", "[]", "null", '"text"']) {
    await expect(
      withNativeInput(input, async () => {
        calls++;
      }),
    ).rejects.toThrow();
  }
  expect(calls).toBe(0);
});
