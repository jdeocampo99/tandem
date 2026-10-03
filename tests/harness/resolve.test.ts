import { expect, test } from "bun:test";
import { DEFAULT_HARNESS, parseHarnessName } from "../../src/harness/contract.ts";
import { ompHarness } from "../../src/harness/omp/launch.ts";
import { HarnessUnavailableError, harnessFor } from "../../src/harness/resolve.ts";

test("OMP is the default harness and resolves to the OMP launch port", () => {
  expect(harnessFor(DEFAULT_HARNESS)).toBe(ompHarness);
});

test("Claude Code fails closed in plain English until its adapter exists", () => {
  const claudeCode = parseHarnessName("claude-code", "harness");
  expect(() => harnessFor(claudeCode)).toThrow(HarnessUnavailableError);
  expect(() => harnessFor(claudeCode)).toThrow(
    'This project is set to run on Claude Code, which Tandem cannot run yet. Set harness = "omp"',
  );
});

test("an unknown harness name is refused where it is read", () => {
  expect(() => parseHarnessName("codex", "harness")).toThrow(
    'harness must be "omp" or "claude-code", not "codex"',
  );
  expect(() => parseHarnessName(undefined, "record.harness")).toThrow(TypeError);
});
