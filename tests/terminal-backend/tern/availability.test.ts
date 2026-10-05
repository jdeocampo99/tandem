import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { probeTern } from "../../../src/terminal-backend/tern/availability.ts";

test("missing Tern falls back without starting a daemon or window", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    throw new Error("ENOENT");
  };
  expect(await probeTern(run)).toMatchObject({
    available: false,
    reason: expect.stringContaining("not installed"),
  });
  expect(calls).toHaveLength(1);
});

for (const signedIn of [true, false]) {
  test(`${signedIn ? "signed-in" : "signed-out"} Tern is detected through an isolated account gate and cleaned up`, async () => {
    const calls: CommandRequest[] = [];
    const aborted: string[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (request.signal !== undefined) {
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
    const result = await probeTern(run);
    expect(result.available).toBe(signedIn);
    if (!signedIn) expect(result).toMatchObject({ reason: expect.stringContaining("Sign in") });
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
