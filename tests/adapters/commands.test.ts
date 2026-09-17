import { expect, test } from "bun:test";
import {
  CommandAbortedError,
  CommandTimeoutError,
  MAX_CAPTURE_BYTES,
  quoteShellCommand,
  runCommand,
} from "../../src/adapters/commands.ts";

test("quotes shell arguments without allowing command substitution", async () => {
  const hostile = "$(printf evaluated) 'quoted'";
  const shellCommand = quoteShellCommand(["printf", "%s", hostile]);
  const result = await runCommand({ argv: ["sh", "-c", shellCommand], cwd: process.cwd() });

  expect(result).toEqual({ code: 0, stdout: hostile, stderr: "" });
});

test("runs argv directly, merges environment, and captures stdin/stdout/stderr", async () => {
  const result = await runCommand({
    argv: [
      "sh",
      "-c",
      "read value; printf '%s' \"$value:$TANDEM_TEST_VALUE\"; printf '%s' 'warning' >&2",
    ],
    cwd: process.cwd(),
    env: { TANDEM_TEST_VALUE: "from-env" },
    stdin: "from-stdin\n",
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("from-stdin:from-env");
  expect(result.stderr).toBe("warning");
});

test("returns nonzero command results without hiding the process evidence", async () => {
  const result = await runCommand({
    argv: ["sh", "-c", "printf '%s' output; printf '%s' failure >&2; exit 7"],
    cwd: process.cwd(),
  });

  expect(result).toEqual({ code: 7, stdout: "output", stderr: "failure" });
});

test("bounds captured output while allowing the command to finish", async () => {
  const result = await runCommand({
    argv: ["sh", "-c", `head -c ${MAX_CAPTURE_BYTES + 1024} /dev/zero`],
    cwd: process.cwd(),
  });

  expect(result.stdout.length).toBe(MAX_CAPTURE_BYTES);
  expect(result.stderr).toBe("");
});

test("aborts a running child and exposes the cancellation reason", async () => {
  const controller = new AbortController();
  const command = runCommand({
    argv: ["sh", "-c", "sleep 10"],
    cwd: process.cwd(),
    signal: controller.signal,
  });
  controller.abort();

  await expect(command).rejects.toBeInstanceOf(CommandAbortedError);
});

test("times out a running child and exposes the configured timeout", async () => {
  const command = runCommand({
    argv: ["sh", "-c", "while :; do :; done"],
    cwd: process.cwd(),
    timeoutMs: 10,
  });
  let caught: unknown;
  try {
    await command;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CommandTimeoutError);
  if (caught instanceof CommandTimeoutError) expect(caught.timeoutMs).toBe(10);
});

// A real subprocess deadline is required to observe group signaling and pipe cleanup.
test("times out and terminates descendants in the owned process group", async () => {
  const startedAt = performance.now();
  let caught: unknown;
  try {
    await runCommand({
      argv: [
        "sh",
        "-c",
        "sh -c 'trap \"\" TERM; sleep 5' >/dev/null 2>&1 & survivor=$!; sleep 2 & holder=$!; printf '%s' \"$survivor\"; wait",
      ],
      cwd: process.cwd(),
      timeoutMs: 20,
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CommandTimeoutError);
  if (!(caught instanceof CommandTimeoutError)) return;

  const survivorPid = Number(caught.stdout.trim());
  expect(Number.isInteger(survivorPid)).toBe(true);
  expect(survivorPid).toBeGreaterThan(0);
  // SIGKILL delivery and orphan reaping may finish after the group signal returns.
  const reapDeadline = performance.now() + 500;
  let descendantExists = true;
  while (performance.now() < reapDeadline) {
    try {
      process.kill(survivorPid, 0);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        throw error;
      }
      descendantExists = false;
      break;
    }
    await Bun.sleep(1);
  }
  expect(descendantExists).toBe(false);
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});
