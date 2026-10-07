import { expect, test } from "bun:test";
import type { ReadableFence } from "../../../src/terminal-backend/contract.ts";
import { herdrBackend } from "../../../src/terminal-backend/herdr/backend.ts";

const fence: ReadableFence = {
  status: "readable",
  kind: "tern-quarantine",
  path: "/home/tern-quarantine/record.json",
  token: "{}",
  protects: {
    endpoint: {
      terminal: "tern",
      sessionId: "session",
      workspaceId: "2",
      tabId: "2",
      paneId: "3",
      role: "implementer",
      generation: 0,
    },
    cwd: "/repo",
  },
  description: "tern send on pane:3 has an unknown outcome",
  proof: { settleable: true, why: "the pane is gone, so the record can be removed" },
};

test("Herdr keeps no fences and refuses to settle one it never listed", async () => {
  const herdr = herdrBackend(async () => ({ code: 1, stdout: "", stderr: "unexpected" }));
  expect(await herdr.fences.list("/home")).toEqual({ fences: [], failures: [] });
  expect(await herdr.fences.settle(fence)).toEqual({
    status: "kept",
    reason: `Herdr keeps no tern-quarantine records, so it never listed ${fence.path}`,
  });
});
