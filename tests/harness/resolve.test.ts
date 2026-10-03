import { expect, test } from "bun:test";
import { MODEL_ROLE_ORDER } from "../../src/contracts.ts";
import { claudeCodeHarness } from "../../src/harness/claude-code/launch.ts";
import { DEFAULT_HARNESS, harnessOf, parseHarnessName } from "../../src/harness/contract.ts";
import { ompHarness } from "../../src/harness/omp/launch.ts";
import {
  catalogueHarness,
  coordinatorHarnesses,
  HarnessUnavailableError,
  harnessFor,
  harnessForRole,
} from "../../src/harness/resolve.ts";

const CLAUDE_CODE = parseHarnessName("claude-code", "harness");

test("only a claude-code/ selector runs in Claude Code; everything else, and no model, runs in OMP", () => {
  expect(harnessOf(undefined)).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "openai-codex/gpt-5.6", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "anthropic/claude-code-x", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "claude-code/opus", thinking: "high" })).toBe(CLAUDE_CODE);
});

test("OMP runs every role", () => {
  for (const role of MODEL_ROLE_ORDER) {
    expect(harnessFor(DEFAULT_HARNESS, role)).toBe(ompHarness);
    expect(harnessForRole(role, { model: "openai-codex/gpt-5.6", thinking: "high" })).toBe(
      ompHarness,
    );
  }
  expect(harnessForRole("coordinator", undefined)).toBe(ompHarness);
});

test("Claude Code runs the coordinator, from a model or from its record", () => {
  expect(harnessForRole("coordinator", { model: "claude-code/opus", thinking: "high" })).toBe(
    claudeCodeHarness,
  );
  expect(harnessFor(CLAUDE_CODE, "coordinator")).toBe(claudeCodeHarness);
});

test("every Claude Code worker role fails closed in plain English", () => {
  for (const role of MODEL_ROLE_ORDER.filter((entry) => entry !== "coordinator")) {
    expect(() => harnessForRole(role, { model: "claude-code/sonnet", thinking: "high" })).toThrow(
      new HarnessUnavailableError(
        `The ${role}'s model is claude-code/sonnet, which runs in Claude Code. Tandem can run only the coordinator in Claude Code so far. Pick a model from another provider for this role with \`tandem configure\`.`,
      ),
    );
    expect(() => harnessFor(CLAUDE_CODE, role)).toThrow(
      new HarnessUnavailableError(
        `This ${role}'s model runs in Claude Code, where Tandem can run only the coordinator so far. Pick a model from another provider for the ${role} with \`tandem configure\`.`,
      ),
    );
  }
});

test("both harnesses can be a coordinator, and OMP alone lists models", () => {
  expect(coordinatorHarnesses()).toEqual([ompHarness, claudeCodeHarness]);
  expect(catalogueHarness()).toBe(ompHarness);
});

test("an unknown harness name is refused where it is read", () => {
  expect(() => parseHarnessName("codex", "harness")).toThrow(
    'harness must be "omp" or "claude-code", not "codex"',
  );
  expect(() => parseHarnessName(undefined, "record.harness")).toThrow(TypeError);
});
