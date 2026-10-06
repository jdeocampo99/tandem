import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeViewText } from "../../src/board/native-views.ts";
import { nativeViewsPath } from "../../src/board/snapshot.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend, TerminalView } from "../../src/terminal-backend/contract.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";
import { withScenario } from "./scenario.ts";

async function withScreens(
  action: (input: {
    call: (...args: string[]) => ReturnType<typeof runTerminal>;
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
    await mkdir(join(world.home, "native-views"), { recursive: true });
    await writeFile(nativeViewsPath(world.home, world.repoPath), nativeViewText("panel", fixture));
    const opened: TerminalView[] = [];
    let fail = false;
    // Reuse the scenario's terminal/process ownership ledger; capture only the presentation port.
    const terminal: TerminalBackend = {
      ...terminalBackend(world.run, { home: world.home }),
      openView: async (input) => {
        opened.push(input.view);
        return { opened: !fail, warnings: fail ? ["isolated renderer unavailable"] : [] };
      },
    };
    const call = (...args: string[]) =>
      runTerminal(["native", ...args, "--pane", "101", "--cwd", lease.path], {
        cwd: world.repoPath,
        processEnvironment: {
          TANDEM_HOME: world.home,
          TANDEM_SESSION: world.sessionId,
          TANDEM_POOL_ROOT: world.poolRoot,
        },
        terminal,
        run: world.run,
        stdout: () => {},
        stderr: () => {},
      });
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
    expect((await call("board")).exitCode).toBe(0);
    expect((await call("usage")).exitCode).toBe(0);
    expect(opened).toEqual([{ kind: "board" }, { kind: "usage" }]);
  });
});

test("native screens refuse a replaced coordinator and return presentation failures without retrying", async () => {
  await withScreens(async ({ call, opened, failOpen, loseOwner }) => {
    failOpen();
    const failure = await call("board");
    expect(failure.exitCode).not.toBe(0);
    expect(failure.error?.message).toContain("isolated renderer unavailable");
    expect(opened).toHaveLength(1);
    loseOwner();
    expect((await call("usage")).exitCode).not.toBe(0);
    expect(opened).toHaveLength(1);
  });
});

test("PR link clicks resolve saved project identities, never arbitrary caller URLs", async () => {
  await withScreens(async ({ call, opened }) => {
    expect((await call("board", "pr-link", "task:terminal-port")).exitCode).toBe(0);
    expect(opened).toEqual([{ kind: "browser", url: "https://github.com/acme/app/pull/281" }]);
    expect((await call("board", "pr-link", "https://attacker.invalid")).exitCode).not.toBe(0);
    expect(opened).toHaveLength(1);
    const merged = "https://github.com/acme/app/pull/276";
    expect((await call("board", "merged-link", merged)).exitCode).toBe(0);
    expect(opened[1]).toEqual({ kind: "browser", url: merged });
    expect((await call("board", "merged-link", "https://attacker.invalid")).exitCode).not.toBe(0);
    expect(opened).toHaveLength(2);
  });
});

test("Open what needs me returns to the orchestrator and opens the saved brief", async () => {
  await withScreens(async ({ call, opened, home }) => {
    expect((await call("board", "catchup-open-needs")).exitCode).toBe(0);
    expect(opened).toEqual([{ kind: "orchestrator" }, { kind: "brief", requestId: "req-tern" }]);
    const entries = await readdir(join(home, "native-visits"));
    const record = entries.find((entry) => entry.endsWith(".json"));
    expect(record).toBeDefined();
    expect(
      JSON.parse(await readFile(join(home, "native-visits", record ?? ""), "utf8"))
        .dismissedSignature,
    ).toBe("after");
  });
});

test("catch-up dismissal still returns when a live publication becomes malformed", async () => {
  await withScreens(async ({ call, opened, home, repo }) => {
    await writeFile(nativeViewsPath(home, repo), "{broken");
    expect((await call("board", "catchup-dismiss")).exitCode).toBe(0);
    expect(opened).toEqual([{ kind: "orchestrator" }]);
  });
});
