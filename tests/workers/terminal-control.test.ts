import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { prepareWorkerTerminal } from "../../src/workers/terminal-control.ts";
import { completedWorker, ENDPOINT, type Pane, paneRunner } from "./terminal-control-fixture.ts";

const FAST: Parameters<typeof prepareWorkerTerminal>[2] = {
  waitMs: 1_500,
  resendAfterMs: 200,
  pollMs: 10,
};

test("a close whose first exit keys are lost is completed by re-sending them (#256)", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: 2 };
    await prepareWorkerTerminal(
      terminalBackend(paneRunner(pane), { terminal: "herdr" }),
      { endpoint: ENDPOINT, cwd: home, job },
      FAST,
    );
    expect(pane.active).toBe(false);
    expect(pane.exitBursts).toBe(2);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("a worker whose process never exits still fails closed after the wait", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: Number.POSITIVE_INFINITY };
    await expect(
      prepareWorkerTerminal(
        terminalBackend(paneRunner(pane), { terminal: "herdr" }),
        { endpoint: ENDPOINT, cwd: home, job },
        FAST,
      ),
    ).rejects.toThrow("has not exited");
    expect(pane.exitBursts).toBeGreaterThanOrEqual(2);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});

test("a close that takes on the first exit keys sends them only once", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-close-"));
  const { job, stopAck } = await completedWorker(home);
  try {
    const pane: Pane = { active: true, exitBursts: 0, exitSendsNeeded: 1 };
    await prepareWorkerTerminal(
      terminalBackend(paneRunner(pane), { terminal: "herdr" }),
      { endpoint: ENDPOINT, cwd: home, job },
      FAST,
    );
    expect(pane.active).toBe(false);
    expect(pane.exitBursts).toBe(1);
  } finally {
    await stopAck();
    await rm(home, { recursive: true, force: true });
  }
});
