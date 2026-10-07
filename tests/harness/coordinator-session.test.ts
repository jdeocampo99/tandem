import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../../src/contracts.ts";
import { openSetupBeside } from "../../src/harness/coordinator-session.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

test("Herdr hosts no native views, so setup stays in the chat and nothing is published or run", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-setup-herdr-"));
  const calls: unknown[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    throw new Error("Herdr setup must not reach the terminal");
  };
  try {
    const terminal = terminalBackend(run, { terminal: "herdr", home });
    expect(terminal.views).toBeUndefined();
    expect(
      await openSetupBeside(
        terminal,
        {
          setupView: async () => {
            throw new Error("Herdr setup must not build a setup view");
          },
        },
        { home, sessionId: "session", repo: home, cwd: home, paneId: "1" },
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
