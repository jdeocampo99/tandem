import { expect, test } from "bun:test";
import { renderNativeLinks } from "../../../src/harness/omp/native-links.ts";

test("native reply link renderer frames known routes and refuses OSC injection in saved details", () => {
  const render = (details: unknown) =>
    renderNativeLinks(
      {
        role: "custom",
        customType: "tandem-native-links",
        content: "Task 102",
        details,
        display: true,
        timestamp: 0,
      },
      { expanded: false },
      {} as Parameters<typeof renderNativeLinks>[2],
    );
  expect(render([{ label: "Task 102", url: "tandem://task/102" }])?.render(80)).toEqual([
    "\x1b]8;;tandem://task/102\x1b\\Task 102\x1b]8;;\x1b\\",
  ]);
  expect(render([{ label: "Task 102\x1b]8;;evil", url: "tandem://task/102" }])).toBeUndefined();
  expect(render([{ label: "task", url: "https://evil.example/" }])).toBeUndefined();
});
