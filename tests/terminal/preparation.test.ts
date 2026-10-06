import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import { createTandemService } from "../../src/service/controller.ts";
import type { TerminalSelection } from "../../src/terminal/onboarding.ts";
import { prepareProjects } from "../../src/terminal/preparation.ts";

for (const [status, answer, expected] of [
  ["ready", "tern", "tern"],
  ["missing", "herdr", "herdr"],
  ["signedOut", "herdr", "herdr"],
  ["unknown", "herdr", "herdr"],
  ["ready", "not-now", "herdr"],
] as const) {
  test(`${status} terminal offer with ${answer} continues preparation and remembers the choice`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tandem-prepare-terminal-"));
    const home = join(root, "home");
    const repoPath = join(root, "repo");
    await mkdir(repoPath);
    const prompts: TerminalSelection[] = [];
    const messages: string[] = [];
    const run: CommandRunner = async (request) => {
      const code =
        request.argv.includes("--version") && request.argv[0] !== "lavish-axi"
          ? status === "missing"
            ? 127
            : status === "unknown"
              ? 1
              : 0
          : 0;
      return {
        code,
        stdout: request.argv.includes("state")
          ? JSON.stringify({ gate: { signed_in: status !== "signedOut" } })
          : "{}",
        stderr: "",
      };
    };
    const service = createTandemService({ home, sessionId: "test", run });
    const states = [
      {
        repoPath,
        existingConfig: true,
        configPath: join(home, "config.json"),
        modelSettings: { configured: true },
      },
    ];
    const environment = {
      cwd: repoPath,
      home,
      sessionId: "test",
      poolRoot: join(home, "pool"),
      source: {},
    };
    const prompter = {
      ask: async (_question: string, selection?: TerminalSelection) => {
        if (selection === undefined) throw new Error("terminal prompt needs choices");
        prompts.push(selection);
        return answer;
      },
      write: (text: string) => {
        messages.push(text);
      },
    };
    try {
      expect(await prepareProjects(states, environment, service, prompter, true, undefined)).toBe(
        states,
      );
      expect((await readHomeSettings(home)).terminal).toBe(expected);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.choices.map((choice) => choice.value)).toEqual(
        status === "ready" ? ["herdr", "tern", "not-now"] : ["herdr", "not-now"],
      );
      if (status !== "ready") expect(messages.join("")).toContain("Using Herdr.");
      // A later launch sees the saved choice, including an explicit decline of Tern.
      expect(await prepareProjects(states, environment, service, prompter, true, undefined)).toBe(
        states,
      );
      expect(prompts).toHaveLength(1);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}
