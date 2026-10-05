import { expect, test } from "bun:test";
import { OUTCOME_CASES } from "./argv-cases.ts";

/**
 * What a caller observes on Herdr failure paths: the class of error a refusal raises and what it
 * leaves in place. `argv-cases.ts` maps each case onto the code under test; this file and these
 * expectations stay fixed across a refactor.
 */
const EXPECTED: Readonly<Record<string, unknown>> = {
  "reset fails closed when the coordinator pane vanishes before its close": {
    error: "AdapterCommandError",
    recordKept: true,
  },
  "reset accepts an older Herdr's plain-text answer that the closed pane is gone": {
    value: 1,
    recordKept: true,
  },
  "restart fails closed when the coordinator pane vanishes before its close": {
    error: "AdapterCommandError",
    replaced: false,
  },
  "restart refuses a plain-text answer that the closed pane is gone": {
    error: "AdapterCommandError",
    replaced: false,
  },
  "launch reports a refused workspace create as a plain error": { error: "Error" },
  "launch reports a refused pane run as a plain error": { error: "Error" },
  "launch reports an unreadable session snapshot as a plain error": { error: "Error" },
  "launch refuses an empty inherited pane variable as a usage error": { error: "CliUsageError" },
  "launch recovery waits on a workspace listing with an unlabelled entry": { status: "pending" },
  "launch recovery waits on a pane listing with an incomplete entry": { status: "pending" },
  "force reset stops when a worker pane's session is gone": {
    error: "AdapterCommandError",
    stage: "scouting",
  },
};

test("every outcome case has one expectation", () => {
  expect(OUTCOME_CASES.map((pin) => pin.name).sort()).toEqual(Object.keys(EXPECTED).sort());
});

for (const pin of OUTCOME_CASES) {
  test(`herdr outcome: ${pin.name}`, async () => {
    expect(await pin.exercise()).toEqual(EXPECTED[pin.name]);
  });
}
