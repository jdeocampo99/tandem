import { expect, test } from "bun:test";
import type { ExtensionContext, InputEvent } from "@oh-my-pi/pi-coding-agent";
import {
  handlePromptInput,
  type PromptRoutingConfig,
  promptRoutingConfig,
} from "../../src/extension/prompt-routing.ts";
import { readPromptRoutingLog } from "../../src/runtime/diagnostics.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { type ScenarioWorld, withScenario } from "./scenario.ts";

const CONTEXT = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;
const PROMPT = "list my tandem tasks";
const ROUTING_CRITERIA: Readonly<Record<string, readonly string[]>> = {
  action: ["list", "presentations", "show", "messages", "inspect", "receipt", "none"],
  target: ["repository", "task", "conversation", "unresolved"],
  effect: ["read-only", "state-change", "sensitive", "unknown"],
  scope: ["within", "changes", "unclear"],
  composition: ["single", "homogeneous-batch", "mixed"],
};

/** Builds the exact answer shape the TypeSafe contract requires for one confident lookup. */
function confidentAnswers(
  choices: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(ROUTING_CRITERIA).map(([question, options]) => {
      const choice = choices[question];
      const remainder = 0.05 / (options.length - 1);
      return [
        question,
        {
          type: "choice",
          choice,
          confidence: 0.95,
          probabilities: Object.fromEntries(
            options.map((option) => [option, option === choice ? 0.95 : remainder]),
          ),
        },
      ];
    }),
  );
}

type RoutingProbe = Readonly<{
  readonly handled: boolean;
  /** Routed actions that ran instead of a coordinator turn. */
  readonly dispatched: number;
  readonly displayed: readonly string[];
  readonly reasons: readonly string[];
}>;

async function routePrompt(
  world: ScenarioWorld,
  config: PromptRoutingConfig,
): Promise<RoutingProbe> {
  const displayed: string[] = [];
  const result = await handlePromptInput(
    { source: "interactive", text: PROMPT } as InputEvent,
    CONTEXT,
    {
      config,
      getService: () =>
        ({
          list: async () => [],
        }) as unknown as TandemService,
      getHome: () => world.home,
      sendMessage: ((message: string | { readonly content?: string }) => {
        displayed.push(typeof message === "string" ? message : (message.content ?? ""));
      }) as never,
    },
  );
  const events = (await readPromptRoutingLog(world.home)).map(
    (line) =>
      JSON.parse(line) as { readonly event: string; readonly details?: { reason?: string } },
  );
  return {
    handled: result?.handled === true,
    dispatched: events.filter((entry) => entry.event === "prompt-route-dispatched").length,
    displayed,
    reasons: events.flatMap((entry) =>
      entry.details?.reason === undefined ? [] : [entry.details.reason],
    ),
  };
}

test("a confident provider answer routes exactly one read-only lookup", async () => {
  await withScenario({}, async (world) => {
    const probe = await routePrompt(world, {
      apiKey: "scenario-key",
      timeoutMs: 1_000,
      fetch: world.providerFetch({
        kind: "answers",
        answers: confidentAnswers({
          action: "list",
          target: "repository",
          effect: "read-only",
          scope: "within",
          composition: "single",
        }),
      }),
    });

    expect(probe.handled).toBe(true);
    expect(probe.dispatched).toBe(1);
    expect(probe.displayed).toHaveLength(1);
    expect(probe.reasons).toContain("direct-read-only");
    expect(world.trace()).toEqual([
      { boundary: "typesafe", action: "typesafe evaluate", outcome: "ok" },
    ]);
  });
});

test("a provider timeout leaves the prompt with the coordinator and records the boundary failure", async () => {
  await withScenario({}, async (world) => {
    const probe = await routePrompt(world, {
      apiKey: "scenario-key",
      timeoutMs: 1,
      fetch: world.providerFetch({ kind: "timeout" }),
    });

    expect(probe.handled).toBe(false);
    expect(probe.dispatched).toBe(0);
    expect(probe.displayed).toEqual([]);
    expect(probe.reasons).toContain("jev-timeout");
    expect(world.trace()).toEqual([
      { boundary: "typesafe", action: "typesafe evaluate", outcome: "refused" },
    ]);
  });
});

test("a malformed provider response never becomes a routed action", async () => {
  await withScenario({}, async (world) => {
    const probe = await routePrompt(world, {
      apiKey: "scenario-key",
      timeoutMs: 1_000,
      fetch: world.providerFetch({ kind: "malformed" }),
    });

    expect(probe.handled).toBe(false);
    expect(probe.dispatched).toBe(0);
    expect(probe.reasons).toContain("jev-invalid-response");
  });
});

test("an answer that omits a required classification is refused as invalid rather than routed", async () => {
  await withScenario({}, async (world) => {
    const probe = await routePrompt(world, {
      apiKey: "scenario-key",
      timeoutMs: 1_000,
      fetch: world.providerFetch({
        kind: "malformed",
        body: JSON.stringify({
          model: "jev-1.13.0",
          answers: { action: { type: "choice", choice: "list", probabilities: {}, confidence: 1 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }),
    });

    expect(probe.handled).toBe(false);
    expect(probe.dispatched).toBe(0);
    expect(probe.reasons).toContain("jev-invalid-response");
  });
});

test("an unavailable provider and an unconfigured provider both fall back without a call", async () => {
  await withScenario({}, async (world) => {
    const unavailable = await routePrompt(world, {
      apiKey: "scenario-key",
      timeoutMs: 1_000,
      fetch: world.providerFetch({ kind: "unavailable" }),
    });
    expect(unavailable.handled).toBe(false);
    expect(unavailable.reasons).toContain("jev-unavailable");

    const unconfigured = await routePrompt(world, promptRoutingConfig({}));
    expect(unconfigured.handled).toBe(false);
    expect(unconfigured.dispatched).toBe(0);
    expect(unconfigured.reasons).toContain("jev-not-configured");
    expect(world.trace().filter((event) => event.boundary === "typesafe")).toHaveLength(1);
  });
});
