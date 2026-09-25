import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import { renderTandemStatus } from "../../src/terminal/status.ts";

const NO_PULL_REQUESTS = { now: "2030-01-01T00:00:00.000Z", rows: [] };

function task(id: string, stage: TaskRecord["stage"], extra: Partial<TaskRecord> = {}): TaskRecord {
  return { id, stage, objective: `objective for ${id}`, ...extra } as unknown as TaskRecord;
}

test("status groups tasks by whether they need you and hides finished ones", () => {
  const rendered = renderTandemStatus({
    code: "abc1234 feat: something (/src/tandem)",
    coordinators: ["/repos/app"],
    tasks: [
      task("task-approve", "awaiting-approval"),
      task("task-blocked", "blocked", { blockReason: "validation failed twice" }),
      task("task-busy", "implementing"),
      task("task-done", "merged"),
      task("task-gone", "cancelled"),
    ],
    pullRequests: NO_PULL_REQUESTS,
  });
  const needsYou = rendered.indexOf("Needs you:");
  const working = rendered.indexOf("Working:");
  expect(rendered).toContain("Tandem code: abc1234 feat: something");
  expect(rendered).toContain("  /repos/app");
  expect(rendered.indexOf("task-approve")).toBeGreaterThan(needsYou);
  expect(rendered.indexOf("task-blocked")).toBeLessThan(working);
  expect(rendered).toContain("validation failed twice");
  expect(rendered.indexOf("task-busy")).toBeGreaterThan(working);
  expect(rendered).not.toContain("task-done");
  expect(rendered).toContain("2 finished tasks hidden.");
});

test("status with nothing running says so plainly", () => {
  const rendered = renderTandemStatus({
    code: "abc1234 x (/t)",
    coordinators: [],
    tasks: [],
    pullRequests: NO_PULL_REQUESTS,
  });
  expect(rendered).toContain("No coordinators are open. Run `tandem`.");
  expect(rendered).toContain("Nothing needs you.");
  expect(rendered).not.toContain("Working:");
});

test("status shows watched pull requests, the ones that need you first", () => {
  const rendered = renderTandemStatus({
    code: "abc1234 x (/t)",
    coordinators: [],
    tasks: [],
    pullRequests: {
      now: "2030-01-01T00:00:05.000Z",
      polledAt: "2030-01-01T00:00:00.000Z",
      rows: [
        {
          repo: "acme/app",
          number: 409,
          branch: "refactor-cache",
          url: "https://github.com/acme/app/pull/409",
          color: "red",
          checks: "❌ 15/16",
          status: "❌ failing",
          note: "🙋 test_cache_evict failed twice",
          link: "https://ci.example/409",
        },
      ],
    },
  });
  expect(rendered).toContain("PR watch · 1 open · checked 5s ago");
  expect(rendered).toContain(
    "🔴 #409 refactor-cache ❌ 15/16 ❌ failing 🙋 test_cache_evict failed twice → https://ci.example/409",
  );
});
