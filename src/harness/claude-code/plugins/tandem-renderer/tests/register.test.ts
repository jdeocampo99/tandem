import type { RenderElement } from "claude-code";
import { expect, test } from "claude-code/testing";

const CLAUDE_CODE_ROW: RenderElement = {
  type: "Text",
  props: {},
  children: ["drawn by Claude Code"],
};

function userMessage(
  origin: { kind: "plugin"; name: string } | { kind: "composer" },
  isExpanded = false,
) {
  return {
    plugin: "tandem-renderer",
    component: "UserMessage",
    requestId: "message-1",
    surface: "terminal",
    viewport: { columns: 100, rows: 30 },
    props: { text: "[hidden]\n\nT-1 finished.", origin, isExpanded },
  } as const;
}

test("a prompt Tandem submitted draws as nothing until it is expanded", async ($, on) => {
  on("ui.render", () => CLAUDE_CODE_ROW);
  const collapsed = await $.ui.mount(userMessage({ kind: "plugin", name: "tandem" }));
  expect(await collapsed.find({ type: "Text" })).toBeUndefined();
  await collapsed.unmount();
  const expanded = await $.ui.mount(userMessage({ kind: "plugin", name: "tandem" }, true));
  expect(await expanded.find({ type: "Text", text: "drawn by Claude Code" })).toBeDefined();
});

test("the person's prompts and other plugins' prompts draw as usual", async ($, on) => {
  on("ui.render", () => CLAUDE_CODE_ROW);
  for (const origin of [{ kind: "composer" }, { kind: "plugin", name: "other" }] as const) {
    const row = await $.ui.mount(userMessage(origin));
    expect(await row.find({ type: "Text", text: "drawn by Claude Code" })).toBeDefined();
    await row.unmount();
  }
});
