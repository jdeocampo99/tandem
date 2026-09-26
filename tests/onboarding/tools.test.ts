import { expect, test } from "bun:test";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { checkTools } from "../../src/onboarding/tools.ts";

function runner(results: Readonly<Record<string, CommandResult | "missing">>) {
  return async (request: CommandRequest): Promise<CommandResult> => {
    const key = request.argv.filter((word) => word !== "--session" && word !== "tandem").join(" ");
    const result = results[key];
    if (result === "missing" || result === undefined) throw new Error(`${key}: not found`);
    return result;
  };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

test("a ready machine passes every check", async () => {
  const checks = await checkTools(
    runner({
      "herdr --version": ok("herdr 0.9.1"),
      "herdr plugin list": ok("- tandem.ui (Tandem) enabled [local:/tandem/herdr-plugin]\n"),
      "omp --version": ok("omp 1.2.3"),
      "git --version": ok("git version 2.50.0"),
      "gh auth status": ok("Logged in"),
    }),
    { cwd: "/tmp", sessionId: "tandem" },
  );
  expect(checks.every((check) => check.ok)).toBe(true);
});

test("each missing tool names the command that fixes it", async () => {
  const checks = await checkTools(
    runner({
      "herdr --version": ok("herdr 0.7.5"),
      "herdr plugin list": ok("No plugins installed.\n"),
      "omp --version": "missing",
      "git --version": ok("git version 2.50.0"),
      "gh auth status": { code: 1, stdout: "", stderr: "not logged in" },
    }),
    { cwd: "/tmp", sessionId: "tandem" },
  );
  const byName = new Map(checks.map((check) => [check.name, check]));
  expect(byName.get("Herdr")).toMatchObject({ ok: false, detail: "0.7.5, needs 0.8.2+" });
  expect(byName.get("OMP")).toMatchObject({
    ok: false,
    fix: "bun install -g @oh-my-pi/pi-coding-agent",
  });
  expect(byName.get("Git")?.ok).toBe(true);
  expect(byName.get("GitHub CLI, signed in (for pull requests and PR watch)")).toMatchObject({
    ok: false,
    fix: "gh auth login",
    optional: true,
  });
});
