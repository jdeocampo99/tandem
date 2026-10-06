import { expect, test } from "bun:test";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

for (const scenario of [
  {
    status: "missing",
    versionExit: 127,
    gate: undefined,
    expected: {
      name: "Tern",
      ok: false,
      detail: "not installed",
      fix: "Install Tern from https://stencil.so/tern",
    },
  },
  {
    status: "signedOut",
    versionExit: 0,
    gate: false,
    expected: {
      name: "Tern",
      ok: false,
      detail: "not signed in",
      fix: "Open Tern and sign in to your Stencil account.",
    },
  },
  {
    status: "unknown",
    versionExit: 0,
    gate: "invalid",
    expected: {
      name: "Tern",
      ok: false,
      detail: "readiness unknown: Tern's sign-in state could not be confirmed in time.",
    },
  },
  {
    status: "ready",
    versionExit: 0,
    gate: true,
    expected: { name: "Tern", ok: true, detail: "ready" },
  },
] as const) {
  test(`installation check maps ${scenario.status} evidence to its user-facing result`, async () => {
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (request.argv.includes("daemon") || request.argv.includes("--dir")) {
        const signal = request.signal;
        if (signal === undefined) throw new Error("probe process requires owned shutdown signal");
        return new Promise((resolve) => {
          const stopped = { code: 0, stdout: "", stderr: "" };
          if (signal.aborted) resolve(stopped);
          else signal.addEventListener("abort", () => resolve(stopped), { once: true });
        });
      }
      if (request.argv.includes("--version"))
        return { code: scenario.versionExit, stdout: "tern test", stderr: "" };
      return {
        code: 0,
        stdout: request.argv.includes("state")
          ? JSON.stringify({ gate: { signed_in: scenario.gate } })
          : "{}",
        stderr: "",
      };
    };
    let time = 0;
    const terminal = ternBackend(run, {
      binary: "/fixture/tern",
      clock: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });
    expect(await terminal.checkInstall({ sessionId: "test", cwd: "/fixture" })).toEqual([
      scenario.expected,
    ]);
    expect(calls.every((request) => request.argv[0] === "/fixture/tern")).toBe(true);
    if (scenario.status === "missing") expect(calls).toHaveLength(1);
    else expect(calls.some((request) => request.argv.includes("state"))).toBe(true);
  });
}
