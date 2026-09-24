import { expect, test } from "bun:test";
import {
  COORDINATOR_RESEARCH_RUNNING_REFUSAL,
  COORDINATOR_TOOL_REFUSAL,
  type CoordinatorToolPolicy,
  coordinatorToolRefusal,
} from "../../src/extension/tool-guard.ts";

function policy(overrides: Partial<CoordinatorToolPolicy> = {}): CoordinatorToolPolicy {
  return {
    allowedServers: async () => ["linear", "react-grab-mcp"],
    researchRunning: async () => false,
    home: "/tandem-home",
    cwd: "/repo",
    ...overrides,
  };
}

test("coordinator is refused browser, web, and unlisted MCP calls", async () => {
  const refused: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__playwright_browser_navigate", content: "{}" }],
    ["mcp__playwright_browser_evaluate", {}],
    ["write", { path: "xd://mcp__sentry_search_issues", content: "{}" }],
    ["read", { path: "https://tagalingo.app/" }],
    ["read", { path: "src; http://localhost:5173/" }],
  ];
  for (const [tool, input] of refused) {
    expect(await coordinatorToolRefusal(tool, input, policy())).toBe(COORDINATOR_TOOL_REFUSAL);
  }
});

test("coordinator keeps listed MCP servers, repository reads, and tool docs", async () => {
  const allowed: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__linear_get_issue", content: "{}" }],
    ["mcp__react_grab_mcp_get_element", {}],
    ["read", { path: "xd://mcp__playwright_browser_navigate" }],
    ["read", { path: "src/main.ts" }],
    ["read", { path: "pr://tagalog-learning-app/42" }],
    ["tandem", { request: { action: "list" } }],
  ];
  for (const [tool, input] of allowed) {
    expect(await coordinatorToolRefusal(tool, input, policy())).toBeUndefined();
  }
});

test("coordinator with no listed servers is refused every MCP call", async () => {
  expect(
    await coordinatorToolRefusal(
      "write",
      { path: "xd://mcp__linear_get_issue" },
      policy({ allowedServers: async () => [] }),
    ),
  ).toBe(COORDINATOR_TOOL_REFUSAL);
});

test("while research runs the coordinator reads only Tandem reports and briefs", async () => {
  const researching = policy({ researchRunning: async () => true });
  const refused = [
    "src/routes/settings.tsx",
    "/repo/CLAUDE.md",
    "/tandem-home/pool/.treehouse/app-db7c/1/app/src/routes/settings.tsx",
    "../other-repo/README.md",
  ];
  for (const path of refused) {
    expect(await coordinatorToolRefusal("read", { path }, researching)).toBe(
      COORDINATOR_RESEARCH_RUNNING_REFUSAL,
    );
  }
  const allowed = [
    "/tandem-home/jobs/abc/report.md",
    "/tandem-home/request-briefs/req-1.md",
    "pr://tagalog-learning-app/42",
    "xd://mcp__linear_get_issue",
  ];
  for (const path of allowed) {
    expect(await coordinatorToolRefusal("read", { path }, researching)).toBeUndefined();
  }
});
