import { expect, test } from "bun:test";
import { CommandStartError } from "../../../src/adapters/commands.ts";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { probeTern, ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

const options = {
  binary: "fake-tern",
  cwd: "/work",
  controlSocket: "/tmp/owned-tern-control.sock",
};

test("the control gate proves ready or signed out without any daemon or version fallback", async () => {
  for (const signedIn of [true, false]) {
    const calls: CommandRequest[] = [];
    const result = await probeTern(async (request) => {
      calls.push(request);
      return { code: 0, stdout: JSON.stringify({ gate: { signed_in: signedIn } }), stderr: "" };
    }, options);
    expect(result).toEqual({ status: signedIn ? "ready" : "signedOut" });
    expect(calls.map((request) => request.argv)).toEqual([
      ["fake-tern", "ctl", "--control", options.controlSocket, "state"],
    ]);
  }
});

test("without a control socket, a harmless scoped daemon listing proves readiness", async () => {
  const calls: CommandRequest[] = [];
  const result = await probeTern(
    async (request) => {
      calls.push(request);
      return { code: 0, stdout: '{"sessions":[],"detached":[]}', stderr: "" };
    },
    { binary: "fake-tern", cwd: "/work", windowKey: "owned-window" },
  );
  expect(result).toEqual({ status: "ready" });
  expect(calls[0]?.argv).toEqual(["fake-tern", "ls", "--window", "owned-window", "--json"]);
});

test("unknown gate evidence never falls through to a successful daemon or version call", async () => {
  for (const stdout of ["bad json", "{}", '{"gate":{"signed_in":"true"}}']) {
    const calls: CommandRequest[] = [];
    const result = await probeTern(async (request) => {
      calls.push(request);
      return { code: 0, stdout, stderr: "" };
    }, options);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.reason.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv[1]).toBe("ctl");
  }
});

test("a missing binary is distinguished from unavailable daemon and control reads", async () => {
  expect(
    await probeTern(async () => ({ code: 127, stdout: "", stderr: "not found" }), options),
  ).toEqual({ status: "missing" });
  const missing: CommandRunner = async (request) => {
    throw new CommandStartError(request, new Error("Executable not found in PATH"));
  };
  expect(await probeTern(missing, options)).toEqual({ status: "missing" });
  for (const controlSocket of [undefined, options.controlSocket]) {
    const result = await probeTern(
      async () => ({ code: 1, stdout: "", stderr: "owned socket is unavailable" }),
      {
        binary: options.binary,
        cwd: options.cwd,
        ...(controlSocket === undefined ? {} : { controlSocket }),
      },
    );
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.reason).toContain("owned socket is unavailable");
  }
});

test("installation checks reject version-only evidence and report sign-in separately", async () => {
  const versionOnly = ternBackend(async () => ({ code: 0, stdout: "tern 0.4.5", stderr: "" }), {
    binary: "fake-tern",
  });
  expect((await versionOnly.checkInstall({ sessionId: "test", cwd: "/work" }))[0]?.ok).toBe(false);
  const signedOut = ternBackend(
    async () => ({ code: 0, stdout: '{"gate":{"signed_in":false}}', stderr: "" }),
    options,
  );
  const check = (await signedOut.checkInstall({ sessionId: "test", cwd: "/work" }))[0];
  expect(check?.ok).toBe(false);
  expect(check?.detail).toBe("not signed in");
});
