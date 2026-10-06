import { expect, test } from "bun:test";
import { ONBOARDING_DONE_TEXT, type OnboardingFacts } from "../../src/onboarding/checklist.ts";
import {
  SETUP_ANSWER_FAILED,
  SETUP_ANSWER_PARTIAL,
  SETUP_ANSWER_PROBLEM,
  SETUP_ANSWER_SAVED,
  SETUP_PAGE_CLOSED,
} from "../../src/onboarding/setup-answer.ts";
import type { SetupApplyResult, SetupPageEvent } from "../../src/onboarding/setup-page.ts";
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
      applySetup: async (): Promise<SetupApplyResult> => ({ message: "", complete: true }),
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
  terminalChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: [],
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
function pageGuide(
  events: readonly SetupPageEvent[],
  applySetup: (repoPath: string, answerId: string) => Promise<SetupApplyResult> = async () => ({
    message: "Saved setup.",
    complete: true,
  }),
) {
  const said: SessionEffect[] = [];
  const replies: (string | undefined)[] = [];
  const queue = [...events];
  let applied = false;
  const { promise: drained, resolve: finish } = Promise.withResolvers<void>();
  let onboarding!: OnboardingGuide;
  onboarding = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        said.push(effect);
        if (
          effect.type === "deliver" &&
          applied &&
          (effect.text === ONBOARDING_DONE_TEXT || effect.text.startsWith(SETUP_ANSWER_PARTIAL))
        ) {
          queueMicrotask(finish);
        }
        if (effect.type === "promptAsUser") {
          onboarding.agentEnd({
            willContinue: false,
            messages: () => [
              { role: "user", content: effect.text },
              { role: "assistant", content: [{ type: "text", text: "Coordinator answer." }] },
            ],
          });
        }
      },
    },
    service: () => ({
      onboardingFacts: async () => ({
        ...unfinished,
        projects: applied ? ["/Users/me/code/api"] : [],
        selfImprovementChosen: applied,
        setupPage: applied ? "done" : "open",
      }),
      checkTools: async () => [],
      awaitSetupAnswer: async (_repo, _signal, reply) => {
        replies.push(reply);
        const next = queue.shift() ?? { kind: "closed" };
        if (queue.length === 0 && next.kind !== "answer") queueMicrotask(finish);
        return next;
      },
      applySetup: async (repoPath, answerId) => {
        const result = await applySetup(repoPath, answerId);
        applied = true;
        return result;
      },
    }),
    repo: "/tandem",
  });
  return { onboarding, said, replies, drained };
}

function waitingPageGuide() {
  const said: SessionEffect[] = [];
  const replies: (string | undefined)[] = [];
  const { promise: prompted, resolve: resolvePrompt } = Promise.withResolvers<string>();
  const { promise: drained, resolve: resolveDrained } = Promise.withResolvers<void>();
  const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
  let calls = 0;
  const onboarding = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        said.push(effect);
        if (effect.type === "promptAsUser") resolvePrompt(effect.text);
      },
    },
    service: () => ({
      onboardingFacts: async () => ({ ...unfinished, setupPage: "open" }),
      checkTools: async () => [],
      awaitSetupAnswer: async (_repo, signal, reply) => {
        replies.push(reply);
        if (++calls === 1) {
          signal.addEventListener("abort", () => resolveAborted(), { once: true });
          return { kind: "comment", text: "Q", ended: false };
        }
        resolveDrained();
        return { kind: "closed" };
      },
      applySetup: async (): Promise<SetupApplyResult> => ({ message: "", complete: true }),
    }),
    repo: "/tandem",
  });
  return { onboarding, said, replies, prompted, aborted, drained };
}

test("a Lavish question waits through unrelated and continuing coordinator turns", async () => {
  const { onboarding, said, replies, prompted, drained } = waitingPageGuide();
  await onboarding.afterAction();
  const prompt = await prompted;
  expect(replies).toEqual([undefined]); // Later Lavish messages stay queued until this answer.
  onboarding.agentEnd({
    willContinue: false,
    messages: () => [
      { role: "user", content: "An unrelated turn" },
      { role: "assistant", content: [{ type: "text", text: "Do not show this." }] },
    ],
  });
  onboarding.agentEnd({
    willContinue: true,
    messages: () => [
      { role: "user", content: prompt },
      { role: "assistant", content: [{ type: "text", text: "Not final." }] },
    ],
  });
  onboarding.agentEnd({
    willContinue: false,
    messages: () => [
      { role: "user", content: prompt },
      { role: "assistant", superseded: true, content: [{ type: "text", text: "Old." }] },
      { role: "assistant", content: "Final answer." },
      {
        role: "assistant",
        content: [{ type: "toolCall", text: "Do not replace the final answer." }],
      },
    ],
  });
  await drained;
  expect(replies.at(-1)).toBe("Final answer.");
  expect(said.filter((effect) => effect.type === "promptAsUser")).toHaveLength(1);
});

test("stopping setup cancels a pending Lavish coordinator wait", async () => {
  const { onboarding, said, prompted, aborted } = waitingPageGuide();
  await onboarding.afterAction();
  const prompt = await prompted;
  onboarding.stop();
  await aborted;
  onboarding.agentEnd({
    willContinue: false,
    messages: () => [
      { role: "user", content: prompt },
      { role: "assistant", content: [{ type: "text", text: "Too late." }] },
    ],
  });
  expect(said.filter((effect) => effect.type === "promptAsUser")).toHaveLength(1);
});

test("a Lavish Save applies exactly once and reports completion without a coordinator turn", async () => {
  const applied: string[] = [];
  const { onboarding, said, replies, drained } = pageGuide(
    [
      { kind: "invalid", problems: ["Tick at least one provider."], ended: false },
      { kind: "answer", answerId: "a-1", ended: false },
    ],
    async (_repo, answerId) => {
      applied.push(answerId);
      return { message: "Saved the model choices and providers.", complete: true };
    },
  );
  await onboarding.sessionStart();
  expect(said).toEqual([]); // the page covers the plain questions
  await onboarding.afterAction();
  await drained;
  expect(applied).toEqual(["a-1"]);
  const delivered = said.flatMap((effect) => (effect.type === "deliver" ? [effect] : []));
  expect(delivered).toHaveLength(3);
  expect(delivered[0]?.text).toBe(`${SETUP_ANSWER_PROBLEM}\n- Tick at least one provider.`);
  expect(delivered[0]?.triggerTurn).toBe(false);
  expect(delivered[1]?.text).toBe(`${SETUP_ANSWER_SAVED}\nSaved the model choices and providers.`);
  expect(delivered[1]?.timing).toBe("aside");
  expect(delivered[1]?.triggerTurn).toBe(false);
  expect(delivered[2]?.text).toBe(ONBOARDING_DONE_TEXT);
  expect(delivered[2]?.triggerTurn).toBe(false);
  expect(replies).toEqual([undefined, `${SETUP_ANSWER_PROBLEM}\n\n- Tick at least one provider.`]);
});

test("a failed apply reports the precise error and leaves the page retryable", async () => {
  const applied: string[] = [];
  let attempts = 0;
  const { onboarding, said, replies, drained } = pageGuide(
    [
      { kind: "answer", answerId: "a-1", ended: false },
      { kind: "answer", answerId: "a-2", ended: false },
    ],
    async (_repo, answerId) => {
      applied.push(answerId);
      if (++attempts === 1) throw new Error("answer changed on disk");
      return { message: "One step failed after retry.", complete: false };
    },
  );
  await onboarding.afterAction();
  await drained;
  expect(applied).toEqual(["a-1", "a-2"]);
  const delivered = said.flatMap((effect) => (effect.type === "deliver" ? [effect] : []));
  expect(delivered).toHaveLength(2);
  expect(delivered.some((effect) => effect.text === ONBOARDING_DONE_TEXT)).toBe(false);
  expect(delivered[0]?.text).toBe(`${SETUP_ANSWER_FAILED}\nanswer changed on disk`);
  expect(delivered[0]?.timing).toBe("aside");
  expect(delivered[0]?.triggerTurn).toBe(false);
  expect(delivered[1]?.text).toBe(`${SETUP_ANSWER_PARTIAL}\nOne step failed after retry.`);
  expect(replies).toEqual([undefined, `${SETUP_ANSWER_FAILED}\nanswer changed on disk`]);
});
test("a question in the open setup page reaches Lavish with the coordinator answer", async () => {
  const { onboarding, said, replies, drained } = pageGuide([
    { kind: "comment", text: "I'm on step 3 and can't find my repos", ended: false },
    { kind: "closed" },
  ]);
  await onboarding.afterAction();
  await drained;
  expect(said).toContainEqual({
    type: "promptAsUser",
    text: "From the open Lavish setup page:\nI'm on step 3 and can't find my repos",
    deliverAs: "aside",
  });
  expect(replies).toEqual([undefined, "Coordinator answer."]);
});

test("successive Lavish questions receive answers in order", async () => {
  const { onboarding, said, replies, drained } = pageGuide([
    { kind: "comment", text: "First question?", ended: false },
    { kind: "comment", text: "Second question?", ended: false },
    { kind: "closed" },
  ]);
  await onboarding.afterAction();
  await drained;
  expect(said.filter((effect) => effect.type === "promptAsUser")).toHaveLength(2);
  expect(replies).toEqual([undefined, "Coordinator answer.", "Coordinator answer."]);
});

test("a folder search stays in Lavish before a direct Save", async () => {
  const { onboarding, said, replies, drained } = pageGuide([
    { kind: "search", reply: "Found 2 repos.", ended: false },
    { kind: "answer", answerId: "a-2", ended: false },
  ]);
  await onboarding.afterAction();
  await drained;
  expect(replies).toEqual([undefined, "Found 2 repos."]);
  expect(said.some((effect) => effect.type === "promptAsUser")).toBe(false);
  expect(said).toContainEqual(expect.objectContaining({ type: "deliver", triggerTurn: false }));
});

test("a page closed without an answer says so once and hands setup back to the chat", async () => {
  const { onboarding, said, drained } = pageGuide([{ kind: "closed" }]);
  await onboarding.afterAction();
  await drained;
  const texts = said.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : []));
  expect(texts).toEqual([SETUP_PAGE_CLOSED]);
});
