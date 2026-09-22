import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import { renderTandemStatus } from "../../src/terminal/status.ts";

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
  const rendered = renderTandemStatus({ code: "abc1234 x (/t)", coordinators: [], tasks: [] });
  expect(rendered).toContain("No coordinators are open. Run `tandem`.");
  expect(rendered).toContain("Nothing needs you.");
  expect(rendered).not.toContain("Working:");
});
