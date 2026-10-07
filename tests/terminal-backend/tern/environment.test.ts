import { expect, test } from "bun:test";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

const tern = ternBackend(async () => ({ code: 0, stdout: "", stderr: "" }));
const inherited = {
  PATH: "/usr/bin",
  HOME: "/Users/me",
  HERDR_ENV: "1",
  HERDR_PANE_ID: "p1",
  TERN_PANE: "42",
};
const overrides = { TANDEM_SESSION: "s1", TANDEM_HOME: "/home" };

test.each([
  {
    name: "a process Tandem starts keeps the inherited environment without Herdr's pane identity",
    environment: tern.launchEnvironment({ overrides, inherited }),
    expected: {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      TERN_PANE: "42",
      TANDEM_SESSION: "s1",
      TANDEM_HOME: "/home",
    },
  },
  {
    // The pane's own login shell supplies PATH and HOME (#348).
    name: "a pane Tern starts gets only Tandem's overrides",
    environment: tern.paneEnvironment({ overrides, inherited }),
    expected: overrides,
  },
  {
    name: "a pane Tern starts gets the overrides and its identity, nothing inherited",
    environment: tern.paneEnvironment({
      overrides: {
        ...overrides,
        ...tern.paneIdentity({ sessionId: "daemon", workspaceId: "tab" }),
      },
      inherited,
    }),
    expected: { TANDEM_SESSION: "daemon", TANDEM_HOME: "/home", TANDEM_TERN_WORKSPACE_ID: "tab" },
  },
])("$name", ({ environment, expected }) => {
  expect(environment).toEqual(expected);
});

test("a Tern pane is identified by Tandem's session and tab", () => {
  expect(tern.paneIdentity({ sessionId: "daemon", workspaceId: "tab" })).toEqual({
    TANDEM_SESSION: "daemon",
    TANDEM_TERN_WORKSPACE_ID: "tab",
  });
});
