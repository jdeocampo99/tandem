import { expect, test } from "bun:test";
import { errorCode, parseEndpoint, parseWorktree, text } from "../../src/coordinator/record.ts";

const endpoint = {
  sessionId: "session",
  workspaceId: "workspace",
  tabId: "tab",
  paneId: "pane",
  role: "coordinator",
  generation: 0,
};

const worktree = {
  root: "/tmp/pool",
  path: "/tmp/pool/worktree",
  name: "name",
  baseHead: "head",
  branch: "branch",
  leaseId: "lease",
  leaseHolder: "holder",
  leasedAt: "time",
};

test("coordinator record text preserves whitespace-only values and NUL byte errors", () => {
  expect(text(" \n ", "field")).toBe(" \n ");
  expect(parseEndpoint({ ...endpoint, sessionId: " " }, "endpoint").sessionId).toBe(" ");
  expect(() => text("\0", "field")).toThrow(
    new TypeError("field must be a non-empty string without NUL bytes"),
  );
});

test("coordinator endpoint generation keeps safe-integer and coordinator-specific errors", () => {
  expect(parseEndpoint(endpoint, "endpoint").generation).toBe(0);
  for (const generation of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseEndpoint({ ...endpoint, generation }, "endpoint")).toThrow(
      new TypeError("endpoint.generation must be a non-negative safe integer"),
    );
  }
  expect(() => parseEndpoint({ ...endpoint, generation: 1 }, "endpoint")).toThrow(
    new TypeError("endpoint.generation must be 0 for a coordinator"),
  );
});

test("coordinator worktree paths keep embedded newlines and reject the filesystem root", () => {
  expect(parseWorktree({ ...worktree, path: "/tmp/a\nb " }, "worktree").path).toBe("/tmp/a\nb ");
  expect(() => parseWorktree({ ...worktree, root: "/" }, "worktree")).toThrow(
    new TypeError("worktree.root must not be the filesystem root"),
  );
  expect(() => parseWorktree({ ...worktree, root: "relative" }, "worktree")).toThrow(
    new TypeError("worktree.root must be absolute"),
  );
});

test("coordinator error codes still require an Error with a string code", () => {
  expect(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe("ENOENT");
  expect(errorCode(Object.assign(new Error("failed"), { code: 1 }))).toBeUndefined();
  expect(errorCode({ code: "ENOENT" })).toBeUndefined();
  expect(errorCode(new Error("failed"))).toBeUndefined();
});
