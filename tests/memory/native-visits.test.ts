import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { maybeShowCatchUp } from "../../src/memory/native-visits.ts";
import { recordVisit } from "../../src/native/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { publishFixture, savedState } from "../native/view-files.ts";
import { viewsWith } from "../terminal-backend/views.ts";

async function savedVisit(home: string, project: string) {
  const visit = (await savedState(home, project))?.visit;
  if (visit === undefined) throw new Error("no visit was saved");
  return visit;
}

test("the project trigger stays quiet without a publication and preserves visits on refused opens", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const project = "/fixture/tandem";
  const record = {
    repoPath: project,
    worktree: { path: "/fixture/pool/coordinator" },
    endpoint: {
      terminal: "tern" as const,
      sessionId: "tandem",
      terminalSessionId: "17",
      workspaceId: "201",
      tabId: "201",
      paneId: "101",
      role: "coordinator" as const,
      generation: 0,
    },
  };
  let attempts = 0;
  const base = terminalBackend(async () => ({ code: 0, stdout: "", stderr: "" }), {
    terminal: "herdr",
  });
  const terminal = {
    ...base,
    name: "tern" as const,
    views: viewsWith(base, {
      open: async () => {
        attempts++;
        return { opened: false, warnings: ["uncertain native outcome"] };
      },
    }),
  };
  try {
    expect(await maybeShowCatchUp(terminal, { home, record })).toBe(false);
    const before = { now: "2030-01-02T10:00:00Z", signature: "before" };
    await recordVisit(home, project, {
      kind: "entry",
      now: before.now,
      signature: before.signature,
      showCatchUp: async () => {},
    });
    await publishFixture(home, project, { writtenAt: before.now, changeSignature: "after" });
    await expect(
      maybeShowCatchUp(terminal, { home, record, now: "2030-01-02T11:00:00Z" }),
    ).rejects.toThrow("uncertain native outcome");
    const saved = await savedVisit(home, project);
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe(before.now);
    expect(attempts).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
