import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { type Action, Outcome } from "../../src/native/envelope.ts";
import { projectStoreDirectory } from "../../src/native/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend, TerminalView } from "../../src/terminal-backend/contract.ts";
import { publishFixture, savedState } from "../native/view-files.ts";
import { viewsWith } from "../terminal-backend/views.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";
import { withScenario } from "./scenario.ts";

async function withScreens(
  action: (input: {
    call: (action: Action) => Promise<Outcome>;
    opened: TerminalView[];
    home: string;
    repo: string;
    failOpen: () => void;
    loseOwner: () => void;
  }) => Promise<void>,
) {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const lease = await world.grantLease({ name: "coordinator", holder: "coordinator:test" });
    const endpoint = {
      ...world.openPane({ paneId: "101", cwd: lease.path }),
      role: "coordinator" as const,
      terminalSessionId: "100",
    };
    const command = ["omp", "--cwd", lease.path, "--session-dir", join(world.home, "conversation")];
    world.replaceForeground("101", command);
    await saveCoordinatorRecord(world.home, {
      schemaVersion: 1,
      repoPath: world.repoPath,
      endpoint,
      command,
      harness: DEFAULT_HARNESS,
      worktree: lease,
    });
    const fixture = { ...nativeScreensFixture(), project: world.repoPath };
    await publishFixture(world.home, world.repoPath, fixture);
    const opened: TerminalView[] = [];
    let fail = false;
    // Reuse the scenario's terminal/process ownership ledger; capture only the presentation port.
    const base = terminalBackend(world.run, { tern: world.tern, home: world.home });
    const terminal: TerminalBackend = {
      ...base,
      views: viewsWith(base, {
        open: async (input) => {
          opened.push(input.view);
          return { opened: !fail, warnings: fail ? ["isolated renderer unavailable"] : [] };
        },
      }),
    };
    const call = async (action: Action): Promise<Outcome> => {
      const output: string[] = [];
      await runTerminal(["native", "act"], {
        input: Readable.from([
          JSON.stringify({ v: 1, origin: { pane: "101", cwd: lease.path }, action }),
        ]),
        cwd: world.repoPath,
        processEnvironment: {
          TANDEM_HOME: world.home,
          TANDEM_SESSION: world.sessionId,
          TANDEM_POOL_ROOT: world.poolRoot,
        },
        terminal,
        run: world.run,
        stdout: (text) => output.push(text),
        stderr: () => {},
      });
      return Outcome.parse(JSON.parse(output.join("")));
    };
    await action({
      call,
      opened,
      home: world.home,
      repo: world.repoPath,
      failOpen: () => {
        fail = true;
      },
      loseOwner: () => world.replaceForeground("101", ["unrelated"]),
    });
  });
}

test("native board and usage invoke the guarded presentation port without changing task state", async () => {
  await withScreens(async ({ call, opened }) => {
    expect((await call({ verb: "open", ref: { kind: "board" } })).status).toBe("done");
    expect((await call({ verb: "open", ref: { kind: "usage" } })).status).toBe("done");
    expect(opened).toEqual([{ kind: "board" }, { kind: "usage" }]);
  });
});

test("native screens refuse a replaced coordinator and return presentation failures without retrying", async () => {
  await withScreens(async ({ call, opened, failOpen, loseOwner }) => {
    failOpen();
    const failure = await call({ verb: "open", ref: { kind: "board" } });
    expect(failure.status).toBe("refused");
    expect(failure.notice?.text).toContain("isolated renderer unavailable");
    expect(opened).toHaveLength(1);
    loseOwner();
    expect((await call({ verb: "open", ref: { kind: "usage" } })).status).toBe("refused");
    expect(opened).toHaveLength(1);
  });
});

test("PR link clicks resolve saved project identities, never arbitrary caller URLs", async () => {
  await withScreens(async ({ call, opened }) => {
    expect((await call({ verb: "board-link", cardKey: "task:terminal-port" })).status).toBe("done");
    expect(opened).toEqual([{ kind: "browser", url: "https://github.com/acme/app/pull/281" }]);
    expect((await call({ verb: "board-link", cardKey: "https://attacker.invalid" })).status).toBe(
      "refused",
    );
    expect(opened).toHaveLength(1);
    const merged = "https://github.com/acme/app/pull/276";
    expect((await call({ verb: "merged-link", url: merged })).status).toBe("done");
    expect(opened[1]).toEqual({ kind: "browser", url: merged });
    expect((await call({ verb: "merged-link", url: "https://attacker.invalid" })).status).toBe(
      "refused",
    );
    expect(opened).toHaveLength(2);
  });
});

test("Open what needs me returns to the orchestrator and opens the saved brief", async () => {
  await withScreens(async ({ call, opened, home, repo }) => {
    expect((await call({ verb: "catchup-open-needs" })).status).toBe("done");
    expect(opened).toEqual([{ kind: "orchestrator" }, { kind: "brief", requestId: "req-tern" }]);
    expect((await savedState(home, repo))?.visit?.dismissedSignature).toBe("after");
  });
});

test("catch-up dismissal still returns when a live publication becomes malformed", async () => {
  await withScreens(async ({ call, opened, home, repo }) => {
    await writeFile(join(projectStoreDirectory(home, repo), "state.json"), "{broken");
    expect((await call({ verb: "catchup-dismiss" })).status).toBe("done");
    expect(opened).toEqual([{ kind: "orchestrator" }]);
  });
});
