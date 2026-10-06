import type { CachedPullRequest, PrThread } from "../../src/pr-review/native-view.ts";
import { prPaneView } from "../../src/pr-review/native-view.ts";

const at = "2030-01-02T03:16:05Z";
function thread(id: string, databaseId: number, body: string, outdated = false): PrThread {
  return {
    id,
    file: outdated ? "removed.ts" : "adapter.ts",
    ...(outdated ? {} : { line: 1 }),
    side: "RIGHT",
    resolved: false,
    outdated,
    comments: [
      {
        id: `node-${databaseId}`,
        databaseId,
        author: databaseId === 11 ? "sam" : "jules",
        at,
        body,
      },
    ],
  };
}
export function followupsFixture(taskless = false) {
  const cached: CachedPullRequest = {
    repo: "owner/repo",
    number: taskless ? 282 : 281,
    title: taskless ? "Watched external PR: resilient uploads" : "Tern backend adapter",
    url: `https://github.com/owner/repo/pull/${taskless ? 282 : 281}`,
    head: "abc123",
    draft: false,
    body: "## What this does\n\nAdds the Tern backend with exact pane ownership.\n\n## Verification\n\nOwnership checks keep unrelated windows and panes safe.",
    commits: 3,
    additions: 2,
    deletions: 1,
    readAt: at,
    checks: [
      { name: "TypeScript", state: "passed", startedAt: at, completedAt: "2030-01-02T03:16:14Z" },
      { name: "Tests", state: "passed", startedAt: at, completedAt: "2030-01-02T03:17:20Z" },
    ],
    conversation: [
      {
        id: "conversation-1",
        author: "alex",
        at,
        body: "The isolation checks look good. Please keep the existing guard.",
      },
    ],
    threads: [
      thread("thread-first", 11, "Why does this need a new backend?"),
      thread("thread-second", 22, "Keep the exact pane ownership guard when reconnecting."),
      thread("thread-outdated", 33, "This removed path still needs coverage.", true),
    ],
    tour: [],
    patch:
      "diff --git a/adapter.ts b/adapter.ts\n--- a/adapter.ts\n+++ b/adapter.ts\n@@ -1,1 +1,2 @@\n-const terminal = herdr();\n+const terminal = tern();\n+export { terminal };\n",
  };
  return prPaneView({
    cached,
    ...(taskless
      ? {}
      : {
          review: {
            taskId: "102",
            generation: 0,
            head: "abc123",
            currentHead: "abc123",
            posted: false,
            intent: "Verify native ownership",
            summary: "",
            drafts: [],
            concerns: [],
            notes: [],
          },
        }),
  });
}
