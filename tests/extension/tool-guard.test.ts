import { expect, test } from "bun:test";
import {
  COORDINATOR_TOOL_REFUSAL,
  coordinatorToolRefusal,
} from "../../src/extension/tool-guard.ts";

const allowLinear = async (): Promise<readonly string[]> => ["linear", "react-grab-mcp"];

test("coordinator is refused browser, web, and unlisted MCP calls", async () => {
  const refused: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__playwright_browser_navigate", content: "{}" }],
    ["mcp__playwright_browser_evaluate", {}],
    ["write", { path: "xd://mcp__sentry_search_issues", content: "{}" }],
    ["read", { path: "https://tagalingo.app/" }],
    ["grep", { pattern: "x", path: "src; https://tagalingo.app/assets/index.js" }],
    ["grep", { pattern: "x", path: ["src", "http://localhost:5173/"] }],
  ];
  for (const [tool, input] of refused) {
    expect(await coordinatorToolRefusal(tool, input, allowLinear)).toBe(COORDINATOR_TOOL_REFUSAL);
  }
});

test("coordinator keeps listed MCP servers, repository reads, and tool docs", async () => {
  const allowed: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__linear_get_issue", content: "{}" }],
    ["mcp__react_grab_mcp_get_element", {}],
    ["read", { path: "xd://mcp__playwright_browser_navigate" }],
    ["read", { path: "src/main.ts" }],
    ["read", { path: "pr://tagalog-learning-app/42" }],
    ["grep", { pattern: "x" }],
    ["tandem", { request: { action: "list" } }],
  ];
  for (const [tool, input] of allowed) {
    expect(await coordinatorToolRefusal(tool, input, allowLinear)).toBeUndefined();
  }
});

test("coordinator with no listed servers is refused every MCP call", async () => {
  expect(
    await coordinatorToolRefusal("write", { path: "xd://mcp__linear_get_issue" }, async () => []),
  ).toBe(COORDINATOR_TOOL_REFUSAL);
});
