import { expect, test } from "bun:test";
import { investigationTrigger } from "../../src/self-improvement/triggers.ts";
import type { StoredTimelineEvent, TimelineEvent } from "../../src/tasks/timeline.ts";

const NOW = new Date("2030-01-01T12:00:00.000Z");

function timeline(...events: readonly TimelineEvent[]): readonly StoredTimelineEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}

const base = { taskId: "task-1", at: "2030-01-01T10:00:00.000Z" } as const;
const restart = { ...base, type: "restarted", role: "worker", attempt: 1 } as const;
const fixRound = { ...base, type: "fix-round", round: 1, generation: 1, findingIds: [] } as const;

test("two restarts or three fix rounds ask; one fewer does not", () => {
  expect(investigationTrigger(timeline(restart), NOW)).toBeUndefined();
  expect(investigationTrigger(timeline(restart, restart), NOW)).toBe("restarts");
  expect(investigationTrigger(timeline(fixRound, fixRound), NOW)).toBeUndefined();
  expect(investigationTrigger(timeline(fixRound, fixRound, fixRound), NOW)).toBe("fix-rounds");
});

test("a block over an hour asks, whether it ended or is still open", () => {
  const blocked = (at: string) => ({ ...base, at, type: "blocked", from: "implementing" }) as const;
  const unblocked = (at: string) =>
    ({ ...base, at, type: "unblocked", to: "implementing" }) as const;
  const shortBlock = timeline(
    blocked("2030-01-01T09:00:00.000Z"),
    unblocked("2030-01-01T09:30:00.000Z"),
  );
  expect(investigationTrigger(shortBlock, NOW)).toBeUndefined();
  const longBlock = timeline(
    blocked("2030-01-01T08:00:00.000Z"),
    unblocked("2030-01-01T09:30:00.000Z"),
  );
  expect(investigationTrigger(longBlock, NOW)).toBe("blocked");
  expect(investigationTrigger(timeline(blocked("2030-01-01T11:30:00.000Z")), NOW)).toBeUndefined();
  expect(investigationTrigger(timeline(blocked("2030-01-01T10:30:00.000Z")), NOW)).toBe("blocked");
});
