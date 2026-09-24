import { describe, expect, test } from "bun:test";
import {
  type DeathProof,
  decideReviewRestart,
  decideValidationRetry,
  decideWorkerRestart,
  MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
  MAX_VALIDATION_RETRIES,
  stageReentry,
} from "../../src/recovery/central-reentry.ts";
import type { RuntimeRecoveryState } from "../../src/runtime/schema.ts";

const fresh: RuntimeRecoveryState = { schemaVersion: 1, validationRetries: 0 };
const proven: DeathProof = { proven: true, deadJobId: "job-1", reasonSummary: "pane vanished" };

describe("stage re-entry table", () => {
  test("maps each recoverable stage to its single re-entry and nothing else", () => {
    expect(stageReentry("implementing")).toBe("relaunch-worker");
    expect(stageReentry("scouting")).toBe("relaunch-worker");
    expect(stageReentry("validating")).toBe("rerun-validation");
    expect(stageReentry("reviewing")).toBe("restart-review");
    expect(stageReentry("awaiting-fixes")).toBe("resume-only");
    expect(stageReentry("blocked")).toBeUndefined();
    expect(stageReentry("completed")).toBeUndefined();
    expect(stageReentry(undefined)).toBeUndefined();
  });
});

describe("decideWorkerRestart", () => {
  test("asks when death is unproven", () => {
    const decision = decideWorkerRestart({
      proof: { ...proven, proven: false },
      recovery: fresh,
      generation: 1,
    });
    expect(decision.kind).toBe("ask");
  });

  test("restarts within budget and counts only the current generation", () => {
    const decision = decideWorkerRestart({
      proof: proven,
      recovery: { ...fresh, restarts: MAX_AUTOMATIC_RESTARTS_PER_GENERATION, restartGeneration: 1 },
      generation: 2,
    });
    expect(decision).toEqual({ kind: "restart", attempt: 1, failureClass: "unknown" });
  });

  test("asks once the generation's restart budget is spent", () => {
    const decision = decideWorkerRestart({
      proof: proven,
      recovery: { ...fresh, restarts: MAX_AUTOMATIC_RESTARTS_PER_GENERATION, restartGeneration: 1 },
      generation: 1,
    });
    expect(decision).toEqual({
      kind: "ask",
      ask: "The worker stopped again after 2 restarts. Restart once more?",
    });
  });

  test("asks when a restart failed immediately the same way as the last one", () => {
    const recovery: RuntimeRecoveryState = {
      ...fresh,
      restarts: 1,
      restartGeneration: 1,
      lastRestartFailureClass: "provider-unavailable",
    };
    const quota: DeathProof = { ...proven, reasonSummary: "rate limit exceeded", elapsedMs: 2_000 };
    expect(decideWorkerRestart({ proof: quota, recovery, generation: 1 }).kind).toBe("ask");
    expect(
      decideWorkerRestart({ proof: { ...quota, elapsedMs: 60_000 }, recovery, generation: 1 }),
    ).toEqual({ kind: "restart", attempt: 2, failureClass: "provider-unavailable" });
  });
});

describe("decideValidationRetry", () => {
  test("retries within budget and asks when unproven or exhausted", () => {
    expect(decideValidationRetry(proven, fresh)).toEqual({ kind: "retry", attempt: 1 });
    expect(decideValidationRetry({ ...proven, proven: false }, fresh).kind).toBe("ask");
    expect(
      decideValidationRetry(proven, { ...fresh, validationRetries: MAX_VALIDATION_RETRIES }),
    ).toEqual({ kind: "ask", ask: "Checks stopped again after 3 retries. Retry once more?" });
  });
});

describe("decideReviewRestart", () => {
  const base = { lensLabel: "security", error: undefined, recovery: fresh, generation: 1 };

  test("never relaunches a lens that may still run or whose code moved", () => {
    expect(decideReviewRestart({ ...base, stop: "still-running" }).kind).toBe("ask");
    expect(decideReviewRestart({ ...base, stop: "code-moved" }).kind).toBe("ask");
  });

  test("restarts a stopped lens within the shared restart budget", () => {
    expect(decideReviewRestart({ ...base, stop: "stopped" })).toEqual({
      kind: "restart",
      attempt: 1,
      failureClass: "unknown",
    });
    expect(
      decideReviewRestart({
        ...base,
        stop: "stopped",
        recovery: { ...fresh, restarts: 2, restartGeneration: 1 },
      }).kind,
    ).toBe("ask");
  });
});
