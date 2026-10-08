import { expect, test } from "bun:test";
import {
  AdapterCommandError,
  AdapterProtocolError,
  readGitText,
  runChecked,
} from "../../src/adapters/primitives.ts";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";

const request: CommandRequest = { argv: ["git", "-C", "/tmp/repo", "status"], cwd: "/tmp/repo" };

test("checked commands retain their result and adapter failure receipt", async () => {
  const success = { code: 0, stdout: " raw\n", stderr: "" };
  expect(await runChecked(async () => success, request, "git status")).toBe(success);
  const failure = { code: 7, stdout: "fallback", stderr: " denied\n" };
  const error = await runChecked(async () => failure, request, "git status").catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AdapterCommandError);
  if (!(error instanceof AdapterCommandError)) throw new Error("expected command failure");
  expect(error.message).toBe(
    'git status exited with code 7: ["git","-C","/tmp/repo","status"] in "/tmp/repo"; denied',
  );
  expect(error.request).toBe(request);
  expect(error.result).toBe(failure);
});

test("checked commands reject malformed runner results before checking success", async () => {
  for (const code of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    const error = await runChecked(
      async () => ({ code, stdout: "", stderr: "" }),
      request,
      "delivery branch push",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterProtocolError);
    if (!(error instanceof AdapterProtocolError)) throw new Error("expected protocol failure");
    expect(error.message).toBe(
      "delivery branch push returned malformed data: command runner returned malformed result",
    );
  }
});

test("git text trims output and keeps empty required reads as protocol errors", async () => {
  const calls: CommandRequest[] = [];
  expect(
    await readGitText(
      async (command) => {
        calls.push(command);
        return { code: 0, stdout: " abc123\n", stderr: "" };
      },
      "/tmp/repo",
      ["rev-parse", "HEAD"],
      "git HEAD",
    ),
  ).toBe("abc123");
  expect(calls).toEqual([
    { argv: ["git", "-C", "/tmp/repo", "rev-parse", "HEAD"], cwd: "/tmp/repo" },
  ]);
  const error = await readGitText(
    async () => ({ code: 0, stdout: " \n", stderr: "" }),
    "/tmp/repo",
    ["rev-parse", "HEAD"],
    "git HEAD",
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdapterProtocolError);
  if (!(error instanceof AdapterProtocolError)) throw new Error("expected protocol failure");
  expect(error.message).toBe("git HEAD returned malformed data: git returned empty stdout");
  expect(error.response).toBe(" \n");
});

test("git text permits empty checkout fields and preserves plain missing-value errors", async () => {
  const run = async () => ({ code: 0, stdout: " \n", stderr: "" });
  expect(
    await readGitText(run, "/tmp/repo", ["branch", "--show-current"], {
      operation: "git scout branch",
      allowEmpty: true,
      failure: "plain",
    }),
  ).toBe("");
  const error = await readGitText(run, "/tmp/repo", ["rev-parse", "HEAD"], {
    operation: "git local source HEAD",
    failure: "plain",
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("expected missing value");
  expect(error.constructor).toBe(Error);
  expect(error.message).toBe("git local source HEAD returned no value");
});

test("plain git failures preserve exit codes and prefer stderr over stdout", async () => {
  const failures: readonly CommandResult[] = [
    { code: 7, stdout: " fallback\n", stderr: " denied\n" },
    { code: 7, stdout: " fallback\n", stderr: " \n" },
    { code: 7, stdout: " \n", stderr: "" },
  ];
  const messages = [
    "git scout HEAD failed with exit code 7: denied",
    "git scout HEAD failed with exit code 7: fallback",
    "git scout HEAD failed with exit code 7",
  ];
  for (const [index, failure] of failures.entries()) {
    const error = await readGitText(async () => failure, "/tmp/repo", ["rev-parse", "HEAD"], {
      operation: "git scout HEAD",
      failure: "plain",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected command failure");
    expect(error.constructor).toBe(Error);
    const expected = messages[index];
    if (expected === undefined) throw new Error("expected failure message");
    expect(error.message).toBe(expected);
  }
});
