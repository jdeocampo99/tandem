import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterCommandError, EndpointOwnershipError } from "../../src/adapters/primitives.ts";
import type { CommandRequest } from "../../src/contracts.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { readWorkerTerminal } from "../../src/workers/terminal.ts";
import { stopWorkerPane, type WorkerPaneStop } from "../../src/workers/terminal-control.ts";
import {
  completedWorker,
  ENDPOINT,
  ok,
  type Pane,
  paneRunner,
} from "./terminal-control-fixture.ts";

async function stopFixture(home: string) {
  const { job, stopAck } = await completedWorker(home);
  const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: 1 };
  const events: string[] = [];
  let elapsed = 0;
  const backend = terminalBackend(paneRunner(pane), { terminal: "herdr" });
  const terminal = {
    ...backend,
    interrupt: async (target: Parameters<typeof backend.interrupt>[0]) => {
      const record = await readWorkerTerminal(job);
      expect(record?.phase).toBe("paused");
      events.push("interrupt");
      expect(target.timeoutMs).toBe(2_000);
      expect(target.pollIntervalMs).toBe(100);
      throw new Error("interrupt timed out");
    },
    close: async () => {
      expect(pane.active).toBe(false);
      events.push("close");
    },
  };
  const input = {
    endpoint: ENDPOINT,
    cwd: home,
    job,
    goal: "close",
    clock: () => elapsed,
    sleep: async (ms: number) => {
      expect(ms).toBe(100);
      events.push("poll");
      elapsed += ms;
    },
    run: async (request: CommandRequest) => {
      events.push("kill");
      expect(request.argv).toEqual(["kill", "-TERM", "1"]);
      expect(request.cwd).toBe(home);
      return ok();
    },
  } satisfies Parameters<typeof stopWorkerPane>[1];
  return { terminal, input, pane, events, stopAck, elapsed: () => elapsed };
}

test("the stop ladder pauses before interrupt, signals only the owned PID, polls, then closes", async () => {
  const home = await mkdtemp(join(tmpdir(), "stop-ladder-"));
  const f = await stopFixture(home);
  try {
    const result = await stopWorkerPane(f.terminal, {
      ...f.input,
      sleep: async (ms) => {
        await f.input.sleep(ms);
        f.pane.active = false;
      },
    });
    expect(result.status).toBe("stopped");
    expect(f.events).toEqual(["interrupt", "kill", "poll", "close"]);
  } finally {
    await f.stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("the stop ladder retains a running pane after exactly five seconds of signal proof", async () => {
  const home = await mkdtemp(join(tmpdir(), "stop-ladder-"));
  const f = await stopFixture(home);
  try {
    expect((await stopWorkerPane(f.terminal, f.input)).status).toBe("still-running");
    expect(f.elapsed()).toBe(5_000);
    expect(f.events.slice(0, 2)).toEqual(["interrupt", "kill"]);
    expect(f.events.filter((event) => event === "poll")).toHaveLength(50);
    expect(f.events).not.toContain("close");
  } finally {
    await f.stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("the stop ladder never signals a recorded PID outside the owned foreground group", async () => {
  const home = await mkdtemp(join(tmpdir(), "stop-ladder-"));
  const f = await stopFixture(home);
  try {
    const terminal = {
      ...f.terminal,
      inspect: async (target: Parameters<typeof f.terminal.inspect>[0]) => {
        const inspection = await f.terminal.inspect(target);
        return {
          ...inspection,
          processInfo: {
            ...inspection.processInfo,
            foregroundProcesses: inspection.processInfo.foregroundProcesses.map((process) => ({
              ...process,
              pid: 2,
            })),
          },
        };
      },
      interrupt: async () => {
        f.events.push("interrupt");
        throw new Error("interrupt timed out");
      },
    };
    expect((await stopWorkerPane(terminal, f.input)).status).toBe("unknown");
    expect(f.events).toEqual(["interrupt"]);
  } finally {
    await f.stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("pausing stops delegation and retains its live worker pane for continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "stop-ladder-"));
  const f = await stopFixture(home);
  try {
    expect((await stopWorkerPane(f.terminal, { ...f.input, goal: "pause" })).status).toBe(
      "stopped",
    );
    expect(f.pane.active).toBe(true);
    expect(f.events).toEqual([]);
    const record = await readWorkerTerminal(f.input.job);
    expect(record?.phase).toBe("paused");
  } finally {
    await f.stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("a retained completed worker needs no pause acknowledgement when only stopping active delegation", async () => {
  const home = await mkdtemp(join(tmpdir(), "stop-ladder-"));
  const f = await stopFixture(home);
  try {
    await f.stopAck();
    expect(
      (await stopWorkerPane(f.terminal, { ...f.input, goal: "pause", skipStopped: true })).status,
    ).toBe("stopped");
    expect((await readWorkerTerminal(f.input.job))?.phase).toBe("idle");
    expect(f.events).toEqual([]);
  } finally {
    await f.stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

for (const status of [
  "stopped",
  "foreign",
  "unknown",
] satisfies readonly WorkerPaneStop["status"][]) {
  test(`the stop ladder classifies ${status} through the backend without signalling an unowned pane`, async () => {
    const error =
      status === "unknown"
        ? new Error("inspection failed")
        : new EndpointOwnershipError(
            ENDPOINT,
            status === "stopped" ? "missing" : "foreign",
            status === "stopped" ? "missing" : "mismatch",
          );
    const events: string[] = [];
    const backend = terminalBackend(async () => ok(), { terminal: "herdr" });
    const terminal = {
      ...backend,
      inspect: async () => {
        throw error;
      },
      close: async () => {
        events.push("close");
        throw error;
      },
      interrupt: async () => {
        throw new Error("must not interrupt");
      },
    };
    const result = await stopWorkerPane(terminal, {
      endpoint: ENDPOINT,
      cwd: "/tmp",
      goal: "close",
      clock: () => 0,
      run: async () => {
        throw new Error("must not signal");
      },
    });
    expect(result.status).toBe(status);
    expect(events).toEqual(status === "stopped" ? ["close"] : []);
    if (result.status === "foreign" || result.status === "unknown")
      expect(result.error).toBe(error);
  });
}

test("a missing tab proven by the backend counts as stopped without signalling", async () => {
  const error = new AdapterCommandError(
    "inspect",
    { argv: ["herdr"], cwd: "/tmp" },
    {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "tab_not_found" } }),
    },
  );
  const backend = terminalBackend(async () => ok(), { terminal: "herdr" });
  const terminal = {
    ...backend,
    inspect: async () => {
      throw error;
    },
    close: async () => {
      throw error;
    },
    interrupt: async () => {
      throw new Error("must not interrupt");
    },
  };
  expect(
    (
      await stopWorkerPane(terminal, {
        endpoint: ENDPOINT,
        cwd: "/tmp",
        goal: "close",
        clock: () => 0,
        run: async () => {
          throw new Error("must not signal");
        },
      })
    ).status,
  ).toBe("stopped");
});
