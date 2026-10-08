import { expect, test } from "bun:test";
import { nativePrFile, nativeSummaryProjects } from "../../src/board/native-views.ts";
import { NOW } from "./fixtures.ts";

const PROJECT = "/work/app";

test("published summaries keep stale project counts visible but never expose a stale focus session", () => {
  const summary = {
    repoPath: PROJECT,
    name: "app",
    writtenAt: NOW,
    running: 2,
    needsYou: 1,
    ready: 0,
    done: 0,
    sessionId: "live-session",
  };
  const fresh = nativeSummaryProjects([summary], PROJECT, NOW)[0];
  expect(fresh).toMatchObject({
    current: true,
    offline: false,
    running: 2,
    needsYou: 1,
    sessionId: "live-session",
  });
  const stale = nativeSummaryProjects(
    [{ ...summary, writtenAt: "2030-01-01T11:59:49.000Z" }],
    PROJECT,
    NOW,
  )[0];
  expect(stale).toMatchObject({ offline: true, running: 2, needsYou: 1, status: "offline" });
  expect(stale).not.toHaveProperty("sessionId");
  expect(nativePrFile("acme/app", 282)).not.toBe(nativePrFile("acme/other", 282));
  expect(nativePrFile("acme/app", 282)).not.toContain("/");
});
