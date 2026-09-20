import { expect, test } from "bun:test";
import {
  loadPromptRoutingFixtures,
  PROMPT_ROUTING_FIXTURE_SET_VERSION,
  parsePromptRoutingFixtures,
} from "../../evals/fixtures.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/prompt-routing.jsonl", import.meta.url).pathname;

const VALID_LINE = JSON.stringify({
  id: "sample",
  fixtureSetVersion: PROMPT_ROUTING_FIXTURE_SET_VERSION,
  description: "A sample fixture.",
  prompt: "list my tandem tasks",
  bypass: "slash-command",
  expectedRoute: "fallback",
  expectedReason: "known-command",
  safety: "bypass",
});

test("loads and validates the checked-in prompt-routing fixture set", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  expect(fixtures.length).toBeGreaterThan(0);
  expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
  for (const fixture of fixtures) {
    expect(fixture.fixtureSetVersion).toBe(PROMPT_ROUTING_FIXTURE_SET_VERSION);
  }
});

test("covers every required fixture category", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const safetyClasses = new Set(fixtures.map((fixture) => fixture.safety));
  expect(safetyClasses).toEqual(
    new Set([
      "safe-direct",
      "ambiguous",
      "state-changing",
      "sensitive",
      "bypass",
      "provider-failure",
    ]),
  );
  expect(fixtures.some((fixture) => fixture.bypass === "slash-command")).toBe(true);
  expect(fixtures.some((fixture) => fixture.bypass === "image")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "unavailable")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "timeout")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "invalid-response")).toBe(true);
  expect(
    fixtures.some((fixture) => fixture.expectedRoute === "direct" && fixture.taskId === undefined),
  ).toBe(true);
});

test("rejects malformed JSON", () => {
  expect(() => parsePromptRoutingFixtures("not json")).toThrow(/not valid JSON/);
});

test("rejects a fixture set declaring the wrong version", () => {
  const line = JSON.stringify({
    id: "sample",
    fixtureSetVersion: "some-other-version",
    description: "d",
    prompt: "p",
    bypass: "slash-command",
    expectedRoute: "fallback",
    expectedReason: "known-command",
    safety: "bypass",
  });
  expect(() => parsePromptRoutingFixtures(line)).toThrow(/declares version/);
});

test("rejects duplicate fixture ids", () => {
  expect(() => parsePromptRoutingFixtures(`${VALID_LINE}\n${VALID_LINE}`)).toThrow(
    /duplicate fixture id/,
  );
});

test("rejects a fixture with neither a response, a failure code, nor a bypass", () => {
  const line = JSON.stringify({
    id: "sample",
    fixtureSetVersion: PROMPT_ROUTING_FIXTURE_SET_VERSION,
    description: "d",
    prompt: "p",
    expectedRoute: "fallback",
    expectedReason: "jev-not-configured",
    safety: "ambiguous",
  });
  expect(() => parsePromptRoutingFixtures(line)).toThrow(/needs a jevResponse/);
});

test("rejects a fixture declaring both a response and a failure code", () => {
  const line = JSON.stringify({
    id: "sample",
    fixtureSetVersion: PROMPT_ROUTING_FIXTURE_SET_VERSION,
    description: "d",
    prompt: "p",
    jevResponse: { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
    jevFailureCode: "timeout",
    expectedRoute: "fallback",
    expectedReason: "jev-timeout",
    safety: "provider-failure",
  });
  expect(() => parsePromptRoutingFixtures(line)).toThrow(/mutually exclusive/);
});

test("rejects an empty fixture set", () => {
  expect(() => parsePromptRoutingFixtures("\n\n")).toThrow(/empty/);
});
