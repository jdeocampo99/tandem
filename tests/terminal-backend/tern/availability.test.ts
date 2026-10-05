import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CommandStartError, CommandTimeoutError } from "../../../src/adapters/commands.ts";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { probeTern } from "../../../src/terminal-backend/tern/availability.ts";

test("missing Tern falls back without starting a daemon or window", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    throw new CommandStartError(request, new Error("Executable not found in PATH"));
  };
  expect(await probeTern(run)).toMatchObject({
    status: "missing",
  });
  expect(calls).toHaveLength(1);
});

for (const signedIn of [true, false, undefined]) {
  test(`${signedIn === undefined ? "unknown" : signedIn ? "signed-in" : "signed-out"} Tern is detected through an isolated account gate and cleaned up`, async () => {
    const calls: CommandRequest[] = [];
    const aborted: string[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (
        request.signal !== undefined &&
        (request.argv.includes("daemon") || request.argv.includes("--dir"))
      ) {
        return new Promise((resolve) =>
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted.push(request.argv.includes("daemon") ? "daemon" : "window");
              resolve({ code: 0, stdout: "", stderr: "" });
            },
            { once: true },
          ),
        );
      }
      return {
        code: 0,
        stdout: request.argv.includes("state")
          ? JSON.stringify({ gate: { signed_in: signedIn } })
          : "{}",
        stderr: "",
      };
    };
    let time = 0;
    const result = await probeTern(run, {
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });
    expect(result.status).toBe(
      signedIn === undefined ? "unknown" : signedIn ? "ready" : "signedOut",
    );
    const operations = calls.filter((call) => !call.argv.includes("--version"));
    const root = operations[0]?.cwd;
    expect(root).toBeDefined();
    for (const operation of operations) {
      expect(operation.env?.TERN_CONFIG_DIR).toBe(`${root}/config`);
      expect(operation.env?.TERN_DAEMON_SOCKET).toBe(`${root}/d.sock`);
      expect(operation.env?.TANDEM_HOME).toBe(`${root}/home`);
    }
    expect(aborted.sort()).toEqual(["daemon", "window"]);
    expect(calls.some((call) => call.argv.at(-1) === "quit")).toBe(true);
    expect(root === undefined || existsSync(root)).toBe(false);
  });
}

test("a version timeout is unknown and never allocates a daemon or window", async () => {
  const calls: CommandRequest[] = [];
  const result = await probeTern(async (request) => {
    calls.push(request);
    throw new CommandTimeoutError(request, 3_000);
  });
  expect(result.status).toBe("unknown");
  if (result.status === "unknown") expect(result.reason).toContain("timed out");
  expect(calls).toHaveLength(1);
});

for (const failure of [
  "daemon-timeout",
  "gate-timeout",
  "quit-timeout",
  "overall-timeout",
] as const) {
  test(`${failure} aborts every owned process and removes all temporary directories`, async () => {
    const calls: CommandRequest[] = [];
    const active = new Set<string>();
    const aborted: string[] = [];
    let time = 0;
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (request.argv.includes("--version")) {
        if (failure === "overall-timeout") time = 7_990;
        return { code: 0, stdout: "tern 0.4.5", stderr: "" };
      }
      if (request.argv.includes("daemon") || request.argv.includes("--dir")) {
        const kind = request.argv.includes("daemon") ? "daemon" : "window";
        active.add(kind);
        return new Promise((resolve) =>
          request.signal?.addEventListener(
            "abort",
            () => {
              active.delete(kind);
              aborted.push(kind);
              resolve({ code: 0, stdout: "", stderr: "" });
            },
            { once: true },
          ),
        );
      }
      if (request.argv.includes("ls")) {
        if (failure === "overall-timeout") time += 50;
        return { code: failure === "daemon-timeout" ? 1 : 0, stdout: "{}", stderr: "" };
      }
      if (
        (failure === "gate-timeout" && request.argv.includes("state")) ||
        (failure === "quit-timeout" && request.argv.includes("quit"))
      ) {
        throw new CommandTimeoutError(request, 1_000);
      }
      return { code: 0, stdout: JSON.stringify({ gate: { signed_in: true } }), stderr: "" };
    };
    const result = await probeTern(run, {
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });
    expect(result.status).toBe("unknown");
    expect(active.size).toBe(0);
    expect(aborted.sort()).toEqual(
      failure === "daemon-timeout" || failure === "overall-timeout"
        ? ["daemon"]
        : ["daemon", "window"],
    );
    const roots = new Set(
      calls.filter((call) => call.env?.TERN_CONFIG_DIR !== undefined).map((call) => call.cwd),
    );
    expect(roots.size).toBe(1);
    for (const root of roots) expect(existsSync(root)).toBe(false);
    expect(
      calls.every(
        (call) => call.timeoutMs !== undefined && call.timeoutMs > 0 && call.timeoutMs <= 8_000,
      ),
    ).toBe(true);
    if (failure !== "daemon-timeout")
      expect(calls.some((call) => call.argv.includes("quit"))).toBe(true);
  });
}
