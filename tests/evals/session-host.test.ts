import { expect, test } from "bun:test";
import { WorkerOutputError } from "../../src/workers/protocol.ts";
import { fakeSessionTime, recordingSessionHost, SCENARIO_NOW } from "./scenario.ts";

test("the recording host keeps every effect in order and fails only the scripted one", async () => {
  const { host, effects, answers, failNext } = recordingSessionHost();
  failNext("deliver");
  const deliver = {
    type: "deliver",
    source: "notification",
    text: "Task finished.",
    timing: "followUp",
    triggerTurn: true,
  } as const;
  await expect(host.perform(deliver)).rejects.toThrow("scripted deliver failure");
  await host.perform(deliver);
  await host.perform({ type: "notify", text: "hi", level: "info" });
  expect(effects.map((effect) => effect.type)).toEqual(["deliver", "deliver", "notify"]);

  expect(await host.confirm("Publish?", "Open a PR")).toBe(false);
  answers.confirm = true;
  expect(await host.confirm("Publish?", "Open a PR")).toBe(true);
  expect(() => host.assertSelectedModel("other/model")).toThrow(WorkerOutputError);
});

test("fake timers fire in due order as the clocks advance, and cancelled ones never fire", () => {
  const time = fakeSessionTime();
  const fired: string[] = [];
  time.timers.every(2_000, () => fired.push(`tick@${time.clock.monotonic()}`));
  time.timers.after(3_000, () => fired.push(`once@${time.clock.monotonic()}`));
  const cancel = time.timers.after(1_000, () => fired.push("cancelled"));
  cancel();

  time.advance(5_000);

  expect(fired).toEqual(["tick@2000", "once@3000", "tick@4000"]);
  expect(time.clock.now()).toBe(Date.parse(SCENARIO_NOW) + 5_000);
  expect(time.pendingTimers()).toBe(1);
});
