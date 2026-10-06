import { expect, test } from "bun:test";
import { usageDisplay } from "../../src/runtime/usage-display.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";

test("usage groups each account's windows and preserves an unavailable quota beside known spend", () => {
  const fixture = nativeScreensFixture();
  const usage = fixture.usage;
  const view = usageDisplay(
    {
      ...usage,
      limits: [
        ...usage.limits,
        {
          provider: "Codex",
          account: "unavailable-account",
          window: "weekly",
          label: "Weekly",
          remainingPercent: "unavailable",
          fetchedAt: "2030-01-02T12:00:00Z",
          resetInMs: "unavailable",
        },
      ],
    },
    { writtenAt: fixture.writtenAt, warnings: [] },
  );
  expect(view.accounts).toHaveLength(3);
  expect(view.accounts[0]?.meters.map((meter) => meter.label)).toEqual(["5-hour window", "Weekly"]);
  expect(view.accounts[2]?.meters[0]).toEqual({
    label: "Weekly",
    remaining: "limit unavailable",
    reset: "reset unavailable",
    fetched: "Fetched at 2030-01-02 12:00:00 UTC",
  });
  expect(view.totals[0]?.value).toBe("$4.12");
});

test("unpriced model samples never appear as fully priced totals and zero spend bars remain finite", () => {
  const bundle = nativeScreensFixture();
  const fixture = bundle.usage;
  const today = { costMicros: 0, unpricedSamples: 1, agentMs: 0, tasksDone: 0 };
  const view = usageDisplay(
    {
      ...fixture,
      today,
      byModel: [{ provider: "codex", model: "unknown-price", today, week: today }],
      malformedEvents: 2,
    },
    { writtenAt: bundle.writtenAt, warnings: [] },
  );
  expect(view.todayModels[0]).toEqual({
    model: "unknown-price",
    cost: "$0.00 + unpriced usage",
    percent: 0,
  });
  expect(view.totals[0]?.value).toContain("unpriced usage");
  expect(view.warning).toContain("totals may be incomplete");
});
