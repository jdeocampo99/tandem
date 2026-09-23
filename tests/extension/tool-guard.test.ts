import { expect, test } from "bun:test";
import {
  COORDINATOR_TOOL_REFUSAL,
  coordinatorToolRefusal,
} from "../../src/extension/tool-guard.ts";

test("coordinator is refused browser, web, and non-Linear MCP calls", () => {
  const refused: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__playwright_browser_navigate", content: "{}" }],
    ["mcp__playwright_browser_evaluate", {}],
    ["write", { path: "xd://mcp__sentry_search_issues", content: "{}" }],
    ["read", { path: "https://tagalingo.app/" }],
    ["grep", { pattern: "x", path: "src; https://tagalingo.app/assets/index.js" }],
    ["grep", { pattern: "x", path: ["src", "http://localhost:5173/"] }],
  ];
  for (const [tool, input] of refused) {
    expect(coordinatorToolRefusal(tool, input)).toBe(COORDINATOR_TOOL_REFUSAL);
  }
});

test("coordinator keeps Linear, repository reads, and tool docs", () => {
  const allowed: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__linear_get_issue", content: "{}" }],
    ["read", { path: "xd://mcp__playwright_browser_navigate" }],
    ["read", { path: "src/main.ts" }],
    ["read", { path: "pr://tagalog-learning-app/42" }],
    ["grep", { pattern: "x" }],
    ["tandem", { request: { action: "list" } }],
  ];
  for (const [tool, input] of allowed) {
    expect(coordinatorToolRefusal(tool, input)).toBeUndefined();
  }
});
