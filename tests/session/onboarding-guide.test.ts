import { expect, test } from "bun:test";
import { ONBOARDING_DONE_TEXT, type OnboardingFacts } from "../../src/onboarding/checklist.ts";
import {
  SETUP_ANSWER_NEXT,
  SETUP_ANSWER_PROBLEM,
  SETUP_ANSWER_RECEIVED,
  SETUP_PAGE_CLOSED,
  SETUP_PAGE_REPLY_RECEIVED,
} from "../../src/onboarding/setup-answer.ts";
import type { SetupPageEvent } from "../../src/onboarding/setup-page.ts";
import type { ToolCheck } from "../../src/onboarding/tools.ts";
import type { SessionEffect } from "../../src/session/events.ts";
import { OnboardingGuide } from "../../src/session/onboarding-guide.ts";

function guide(initial: OnboardingFacts, tools: readonly ToolCheck[] = []) {
  let facts = initial;
  const said: SessionEffect[] = [];
  const onboarding = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        said.push(effect);
      },
    },
    service: () => ({
      onboardingFacts: async () => facts,
      checkTools: async () => tools,
      awaitSetupAnswer: async () => ({ kind: "closed" }),
    }),
    repo: "/tandem",
  });
  const texts = () => said.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : []));
  return {
    onboarding,
    texts,
    set: (next: Partial<OnboardingFacts>) => {
      facts = { ...facts, ...next };
    },
  };
}

const unfinished: OnboardingFacts = {
  modelsChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: [],
  workerSkillOffer: [],
  selfImprovementChosen: false,
  setupPage: "unavailable",
};

test("setup reports missing tools at start and asks each plain question once", async () => {
  const { onboarding, texts } = guide(unfinished, [
    { name: "OMP", ok: false, detail: "not found", fix: "bun install -g omp" },
    { name: "Git", ok: true, detail: "git 2.50" },
  ]);
  await onboarding.sessionStart();
  expect(texts()).toHaveLength(2);
  expect(texts()[0]).toContain("- OMP, not found: run `bun install -g omp`");
  expect(texts()[1]).toStartWith("When a task keeps failing");
  await onboarding.afterAction();
  expect(texts()).toHaveLength(2);
});

test("the closing message comes once, when the last step is saved", async () => {
  const { onboarding, texts, set } = guide(unfinished);
  await onboarding.sessionStart();
  set({ selfImprovementChosen: true, projects: ["/Users/me/code/api"] });
  await onboarding.afterAction();
  await onboarding.afterAction();
  expect(texts().filter((text) => text === ONBOARDING_DONE_TEXT)).toHaveLength(1);
  expect(await onboarding.context()).toEqual([]);
});

test("a home that was already set up hears nothing", async () => {
  const { onboarding, texts } = guide({
    ...unfinished,
    selfImprovementChosen: true,
    projects: ["/Users/me/code/api"],
  });
  await onboarding.sessionStart();
  await onboarding.afterAction();
  expect(texts()).toEqual([]);
});

function pageGuide(events: readonly SetupPageEvent[]) {
  const said: SessionEffect[] = [];
  const replies: (string | undefined)[] = [];
  const queue = [...events];
  let finished: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const onboarding = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        said.push(effect);
      },
    },
    service: () => ({
      onboardingFacts: async () => ({ ...unfinished, setupPage: "open" }),
      checkTools: async () => [],
      awaitSetupAnswer: async (_repo, _signal, reply) => {
        replies.push(reply);
        const next = queue.shift() ?? { kind: "closed" };
        if (queue.length === 0) setTimeout(finished, 0);
        return next;
      },
    }),
    repo: "/tandem",
  });
  return { onboarding, said, replies, drained };
}

test("an answer from the setup page reaches the chat as fixed text naming one action", async () => {
  const { onboarding, said, replies, drained } = pageGuide([
    { kind: "invalid", problems: ["Tick at least one provider."], ended: false },
    { kind: "answer", answerId: "a-1", recap: ["Providers: anthropic"], ended: false },
    { kind: "closed" },
  ]);
  await onboarding.sessionStart();
  expect(said).toEqual([]); // the page covers the plain questions
  await onboarding.afterAction();
  await onboarding.afterAction(); // one listener, however many actions follow
  await drained;
  const delivered = said.flatMap((effect) => (effect.type === "deliver" ? [effect] : []));
  expect(delivered).toHaveLength(2);
  expect(delivered[0]?.text).toBe(`${SETUP_ANSWER_PROBLEM}\n- Tick at least one provider.`);
  expect(delivered[0]?.triggerTurn).toBe(false);
  expect(delivered[1]?.text).toBe(
    [SETUP_ANSWER_RECEIVED, "Providers: anthropic", SETUP_ANSWER_NEXT].join("\n"),
  );
  expect(delivered[1]?.hidden?.text).toContain(
    'apply-setup with repoPath "/tandem" and answerId "a-1"',
  );
  expect(delivered[1]?.triggerTurn).toBe(true);
  expect(replies).toEqual([
    undefined,
    `${SETUP_ANSWER_PROBLEM}\n\n- Tick at least one provider.`,
    SETUP_PAGE_REPLY_RECEIVED,
  ]);
});

test("a page closed without an answer says so once and hands setup back to the chat", async () => {
  const { onboarding, said, drained } = pageGuide([{ kind: "closed" }]);
  await onboarding.afterAction();
  await drained;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const texts = said.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : []));
  expect(texts).toEqual([SETUP_PAGE_CLOSED]);
});
