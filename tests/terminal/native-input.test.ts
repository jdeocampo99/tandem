import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
        expect((await stat(path)).mode & 0o777).toBe(0o400);
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

test("native input transport leaves JSON and domain validation to the CLI", async () => {
  for (const input of ["{", "[]", "null", '"text"']) {
    let calls = 0;
    await withNativeInput(input, async (path) => {
      calls++;
      expect(await readFile(path, "utf8")).toBe(input);
    });
    expect(calls).toBe(1);
  }
});

test("shared native caller preserves argv, UTF-8, stderr and failed exit with cleanup and no retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-input-caller-"));
  try {
    await mkdir(join(root, "src", "terminal"), { recursive: true });
    await mkdir(join(root, "plugin"));
    await cp(
      fileURLToPath(new URL("../../src/terminal/native-input.ts", import.meta.url)),
      join(root, "src", "terminal", "native-input.ts"),
    );
    await cp(
      fileURLToPath(new URL("../../tern-plugin/native-input.sh", import.meta.url)),
      join(root, "plugin", "native-input.sh"),
    );
    await writeFile(
      join(root, "src", "main.ts"),
      `import {appendFileSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
appendFileSync(${JSON.stringify(join(root, "calls.txt"))}, "called\\n");
const argv = Bun.argv.slice(2);
const path = argv[argv.indexOf("--input") + 1];
writeFileSync(${JSON.stringify(join(root, "receipt.json"))}, JSON.stringify({argv, path, input: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777, directoryMode: statSync(dirname(path)).mode & 0o777}));
console.log("Native CLI result");
console.error("CLI domain refused 日本語");
process.exitCode = 7;
`,
    );
    const context = [
      "--pane",
      "123",
      "--cwd",
      join(root, "path with spaces `$(echo text)`"),
      "--window",
      "opaque window",
      "--home",
      join(root, "custom home"),
    ];
    const input = JSON.stringify({
      comments: [{ lineId: "stable:id", text: "日本語 😀 `$(echo text)`" }],
    });
    const child = Bun.spawn(
      [
        "/bin/sh",
        join(root, "plugin", "native-input.sh"),
        "brief-request-changes",
        "request-id",
        ...context,
      ],
      { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(7);
    expect(stdout).toBe("Native CLI result\n");
    expect(stderr).toBe("CLI domain refused 日本語\n");
    expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
    const receipt = JSON.parse(await readFile(join(root, "receipt.json"), "utf8")) as {
      argv: string[];
      path: string;
      input: string;
      mode: number;
      directoryMode: number;
    };
    expect(receipt.argv).toEqual([
      "native",
      "brief-request-changes",
      "request-id",
      "--input",
      receipt.path,
      ...context,
    ]);
    expect(receipt.input).toBe(input);
    expect(receipt.mode).toBe(0o400);
    expect(receipt.directoryMode).toBe(0o700);
    expect(await Bun.file(receipt.path).exists()).toBe(false);
    expect(await Bun.file(dirname(receipt.path)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
