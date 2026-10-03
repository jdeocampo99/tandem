import { expect, test } from "bun:test";
import { claudeCodeAvailability } from "../../../src/harness/claude-code/availability.ts";

test("Claude Code is ready only when it runs and managed settings leave mods on", () => {
  expect(claudeCodeAvailability(0, undefined)).toBe("ready");
  expect(claudeCodeAvailability(0, '{"disableAllHooks":false}')).toBe("ready");
  expect(claudeCodeAvailability(0, "not json")).toBe("ready");
  expect(claudeCodeAvailability(0, '{"disableAllHooks":true}')).toBe("mods-off");
  expect(claudeCodeAvailability(127, undefined)).toBe("not-installed");
  expect(claudeCodeAvailability(undefined, '{"disableAllHooks":true}')).toBe("not-installed");
});
