import { expect, test } from "bun:test";
import { DEFAULT_HARNESS, harnessOf, parseHarnessName } from "../../src/harness/contract.ts";
import { ompHarness } from "../../src/harness/omp/launch.ts";
import { HarnessUnavailableError, harnessFor, harnessForRole } from "../../src/harness/resolve.ts";

test("only a claude-code/ selector runs in Claude Code; everything else, and no model, runs in OMP", () => {
  expect(harnessOf(undefined)).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "openai-codex/gpt-5.6", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "anthropic/claude-code-x", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "claude-code/opus", thinking: "high" })).toBe(
    parseHarnessName("claude-code", "harness"),
  );
});

test("OMP is the default harness and resolves to the OMP launch port", () => {
  expect(harnessFor(DEFAULT_HARNESS)).toBe(ompHarness);
  expect(harnessForRole("coordinator", undefined)).toBe(ompHarness);
  expect(harnessForRole("scout", { model: "openai-codex/gpt-5.6", thinking: "high" })).toBe(
    ompHarness,
  );
});

test("Claude Code fails closed in plain English until its adapter exists", () => {
  expect(() => harnessFor(parseHarnessName("claude-code", "harness"))).toThrow(
    new HarnessUnavailableError(
      "This agent's model runs in Claude Code, and Tandem can't run Claude Code yet. Pick a model from another provider for its role with `tandem configure`.",
    ),
  );
  expect(() => harnessForRole("scout", { model: "claude-code/sonnet", thinking: "high" })).toThrow(
    new HarnessUnavailableError(
      "The scout's model is claude-code/sonnet, which runs in Claude Code. Tandem can't run Claude Code yet. Pick a model from another provider for this role with `tandem configure`.",
    ),
  );
});

test("an unknown harness name is refused where it is read", () => {
  expect(() => parseHarnessName("codex", "harness")).toThrow(
    'harness must be "omp" or "claude-code", not "codex"',
  );
  expect(() => parseHarnessName(undefined, "record.harness")).toThrow(TypeError);
});
