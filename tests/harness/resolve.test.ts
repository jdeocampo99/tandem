import { expect, test } from "bun:test";
import type { CommandRunner } from "../../src/contracts.ts";
import { claudeCodeHarness } from "../../src/harness/claude-code/launch.ts";
import { DEFAULT_HARNESS, harnessOf, parseHarnessName } from "../../src/harness/contract.ts";
import { ompHarness } from "../../src/harness/omp/launch.ts";
import {
  catalogueHarness,
  coordinatorHarnesses,
  harnessFor,
  runnableModels,
} from "../../src/harness/resolve.ts";

const CLAUDE_CODE = parseHarnessName("claude-code", "harness");

test("only a claude-code/ selector runs in Claude Code; everything else, and no model, runs in OMP", () => {
  expect(harnessOf(undefined)).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "openai-codex/gpt-5.6", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "anthropic/claude-code-x", thinking: "high" })).toBe(DEFAULT_HARNESS);
  expect(harnessOf({ model: "claude-code/opus", thinking: "high" })).toBe(CLAUDE_CODE);
});

test("each harness name resolves to its harness, which runs every role", () => {
  expect(harnessFor(DEFAULT_HARNESS)).toBe(ompHarness);
  expect(harnessFor(CLAUDE_CODE)).toBe(claudeCodeHarness);
  expect(harnessFor(harnessOf({ model: "claude-code/sonnet", thinking: "low" }))).toBe(
    claudeCodeHarness,
  );
  expect(harnessFor(harnessOf(undefined))).toBe(ompHarness);
});

test("OMP exits on one Ctrl-D", () => {
  expect(ompHarness.exitKeys).toEqual(["ctrl+d"]);
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

test("a role may run on any OMP-listed model or any Claude Code model", async () => {
  const run: CommandRunner = async () => ({
    code: 0,
    stdout: JSON.stringify({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.5",
          selector: "openai-codex/gpt-5.5",
          thinking: ["low"],
        },
      ],
    }),
    stderr: "",
  });
  expect((await runnableModels(run, "/repo")).map((model) => model.selector)).toEqual([
    "openai-codex/gpt-5.5",
    "claude-code/fable",
    "claude-code/opus",
    "claude-code/sonnet",
    "claude-code/haiku",
  ]);
});
