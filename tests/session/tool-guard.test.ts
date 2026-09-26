import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ompMcpToolPrefix, ompToolCall } from "../../src/extension/omp-host.ts";
import { registerTandemOmp } from "../../src/extension/registration.ts";
import type { TandemService } from "../../src/service/controller.ts";
import type { ToolCall } from "../../src/session/events.ts";
import {
  COORDINATOR_RESEARCH_RUNNING_REFUSAL,
  COORDINATOR_TOOL_REFUSAL,
  type CoordinatorToolPolicy,
  coordinatorToolRefusal,
} from "../../src/session/tool-guard.ts";

function policy(overrides: Partial<CoordinatorToolPolicy> = {}): CoordinatorToolPolicy {
  return {
    allowedServers: async () => ["linear", "react-grab-mcp"],
    researchRunning: async () => false,
    mcpToolPrefix: ompMcpToolPrefix,
    home: "/tandem-home",
    cwd: "/repo",
    userHome: "/Users/someone",
    realpath: async (path) => path,
    ...overrides,
  };
}

/** How OMP presents a tool call: its native name and raw input. */
function omp(toolName: string, input: Record<string, unknown>): ToolCall {
  return ompToolCall({ toolCallId: "call-1", toolName, input });
}

test("OMP tool calls classify into kinds, with MCP calls under either native shape", () => {
  expect(omp("read", { path: "src/main.ts" })).toEqual({
    id: "call-1",
    name: "read",
    kind: "read",
    path: "src/main.ts",
  });
  expect(omp("bash", { command: "ls" })).toMatchObject({ kind: "shell", command: "ls" });
  expect(omp("mcp__linear_get_issue", {})).toMatchObject({
    kind: "mcp",
    mcpTool: "mcp__linear_get_issue",
  });
  expect(omp("write", { path: "xd://mcp__linear_get_issue", content: "{}" })).toMatchObject({
    kind: "mcp",
    mcpTool: "mcp__linear_get_issue",
  });
  // Reading an MCP tool's docs is a read, not an MCP call.
  expect(omp("read", { path: "xd://mcp__linear_get_issue" })).toMatchObject({ kind: "read" });
  expect(omp("write", { path: "notes.md" })).toMatchObject({ kind: "write" });
  expect(omp("read", { path: 42 })).toEqual({ id: "call-1", name: "read", kind: "read" });
  expect(omp("tandem", { request: { action: "list" } })).toMatchObject({ kind: "other" });
});

test("OMP's MCP tool prefix sanitizes the server name like OMP does", () => {
  expect(ompMcpToolPrefix("react-grab-mcp")).toBe("mcp__react_grab_mcp_");
  expect(ompMcpToolPrefix("Linear")).toBe("mcp__linear_");
  expect(ompMcpToolPrefix("--")).toBe("mcp__server_");
});

test("coordinator is refused browser, web, and unlisted MCP calls", async () => {
  const refused: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__playwright_browser_navigate", content: "{}" }],
    ["mcp__playwright_browser_evaluate", {}],
    ["write", { path: "xd://mcp__sentry_search_issues", content: "{}" }],
    ["read", { path: "https://tagalingo.app/" }],
    ["read", { path: "src; http://localhost:5173/" }],
  ];
  for (const [tool, input] of refused) {
    expect(await coordinatorToolRefusal(omp(tool, input), policy())).toBe(COORDINATOR_TOOL_REFUSAL);
  }
});

test("coordinator keeps listed MCP servers, repository reads, and tool docs", async () => {
  const allowed: [string, Record<string, unknown>][] = [
    ["write", { path: "xd://mcp__linear_get_issue", content: "{}" }],
    ["mcp__react_grab_mcp_get_element", {}],
    ["read", { path: "xd://mcp__playwright_browser_navigate" }],
    ["read", { path: "src/main.ts" }],
    ["read", { path: "pr://tagalog-learning-app/42" }],
    ["write", { path: "src/main.ts", content: "" }],
    ["bash", { command: "curl https://example.com" }],
    ["tandem", { request: { action: "list" } }],
  ];
  for (const [tool, input] of allowed) {
    expect(await coordinatorToolRefusal(omp(tool, input), policy())).toBeUndefined();
  }
});

test("coordinator with no listed servers is refused every MCP call", async () => {
  expect(
    await coordinatorToolRefusal(
      omp("write", { path: "xd://mcp__linear_get_issue" }),
      policy({ allowedServers: async () => [] }),
    ),
  ).toBe(COORDINATOR_TOOL_REFUSAL);
});

test("MCP calls match the host's tool prefix, not OMP's", async () => {
  const call: ToolCall = {
    id: "call-1",
    name: "mcp__linear__get_issue",
    kind: "mcp",
    mcpTool: "mcp__linear__get_issue",
  };
  const claudeStyle = policy({ mcpToolPrefix: (server) => `mcp__${server}__` });
  expect(await coordinatorToolRefusal(call, claudeStyle)).toBeUndefined();
  expect(
    await coordinatorToolRefusal({ ...call, mcpTool: "mcp__sentry__search" }, claudeStyle),
  ).toBe(COORDINATOR_TOOL_REFUSAL);
});

test("while research runs the coordinator reads only Tandem reports and briefs", async () => {
  const researching = policy({ researchRunning: async () => true });
  const refused = [
    "src/routes/settings.tsx",
    "/repo/CLAUDE.md",
    "/tandem-home/pool/.treehouse/app-db7c/1/app/src/routes/settings.tsx",
    "../other-repo/README.md",
    "~/notes.md",
  ];
  for (const path of refused) {
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBe(
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
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBeUndefined();
  }
});

test("the registered OMP tool_call hook blocks with the guard's reason", async () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI;
  registerTandemOmp(pi, {
    getService: () => ({}) as TandemService,
    getHome: () => "/tandem-home",
    promptRouting: { timeoutMs: 1_500 },
    reconcile: async () => undefined,
    postAction: async () => undefined,
    userPrompt: () => undefined,
    closeThread: () => undefined,
    coordinatorMcpServers: async () => ["linear"],
    researchRunning: async () => false,
  });
  const hook = handlers.get("tool_call");
  if (hook === undefined) throw new Error("tool_call hook was not registered");
  const call = (toolName: string, input: object) =>
    hook({ type: "tool_call", toolCallId: "call-1", toolName, input }, { cwd: "/repo" });
  expect(await call("write", { path: "xd://mcp__playwright_browser_navigate" })).toEqual({
    block: true,
    reason: COORDINATOR_TOOL_REFUSAL,
  });
  expect(await call("mcp__linear_get_issue", {})).toBeUndefined();
  expect(await call("read", { path: "src/main.ts" })).toBeUndefined();
});

test("a home reached through a symlink or ~ still counts as Tandem's records", async () => {
  const researching = policy({
    researchRunning: async () => true,
    home: "/Users/someone/.tandem",
    realpath: async () => "/private/tandem",
  });
  for (const path of ["/private/tandem/jobs/abc/report.md", "~/.tandem/jobs/abc/report.md"]) {
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBeUndefined();
  }
});
