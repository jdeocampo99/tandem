import { expect, test } from "bun:test";
import { openSteps, todoItems } from "../../src/workers/todos.ts";

const steps = ["Measure a baseline", "Find the cause", "Measure again"];
const result = (tasks: ReadonlyArray<{ content: string; status: string }>) => ({
  details: { op: "done", phases: [{ name: "Steps", tasks }] },
});

test("completed and abandoned steps close; open, blocked, and missing ones stay open", () => {
  const all = todoItems(
    result([
      { content: "Measure a baseline", status: "completed" },
      { content: "Find the cause", status: "abandoned" },
      { content: "Measure again", status: "completed" },
    ]),
  );
  expect(openSteps(steps, all)).toEqual([]);

  const partial = todoItems(
    result([
      { content: "Measure a baseline", status: "completed" },
      { content: "Find the cause", status: "blocked" },
    ]),
  );
  expect(openSteps(steps, partial)).toEqual(["Find the cause", "Measure again"]);
  expect(openSteps(steps, undefined)).toEqual(steps);
  expect(todoItems({ details: { phases: [{ tasks: [{ content: 1 }] }] } })).toBeUndefined();
});
