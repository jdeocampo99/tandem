import { expect, test } from "bun:test";
import type { CommandRunner } from "../../../src/contracts.ts";
import { herdrBackend } from "../../../src/terminal-backend/herdr/backend.ts";

const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
const herdr = herdrBackend(run);
const inherited = {
  PATH: "/usr/bin",
  HOME: "/Users/me",
  HERDR_ENV: "1",
  HERDR_PANE_ID: "p1",
  TERN_PANE: "42",
  TANDEM_TERN_WORKSPACE_ID: "tab",
};
const overrides = { TANDEM_SESSION: "s1", TANDEM_HOME: "/home" };
const expected = {
  PATH: "/usr/bin",
  HOME: "/Users/me",
  HERDR_ENV: "1",
  HERDR_PANE_ID: "p1",
  TANDEM_SESSION: "s1",
  TANDEM_HOME: "/home",
};

test.each([
  ["a process Tandem starts", herdr.launchEnvironment],
  ["a pane Herdr starts", herdr.paneEnvironment],
])("%s keeps the inherited environment and drops Tern's pane identity", (_, environmentFor) => {
  expect(environmentFor({ overrides, inherited })).toEqual(expected);
});

test("an override replaces the inherited value", () => {
  expect(
    herdr.paneEnvironment({ overrides: { PATH: "/opt/bin" }, inherited: { PATH: "/usr/bin" } }),
  ).toEqual({ PATH: "/opt/bin" });
});

test("Herdr panes need no identity from Tandem", () => {
  expect(herdr.paneIdentity({ sessionId: "s1", workspaceId: "w1" })).toEqual({});
});
