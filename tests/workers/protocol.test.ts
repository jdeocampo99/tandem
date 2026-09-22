import { expect, test } from "bun:test";
import { join } from "node:path";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import { resolveSubmittedReport } from "../../src/workers/protocol.ts";

function implementerJob(root: string): WorkerJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "implementer",
    cwd: root,
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    prompt: "Complete the approved worker brief.",
    resultPath: join(root, "result.json"),
    userChecks: { directory: "/tmp/user-checks", criteria: ["Streak bar glows"] },
  };
}

test("resolveSubmittedReport refuses userCheckEvidence paths outside the job's user-check directory", () => {
  expect(() =>
    resolveSubmittedReport(implementerJob("/repo"), {
      outcome: "implemented",
      report: "Added the streak bar.",
      userCheckEvidence: [
        { criterion: "Streak bar glows", paths: ["/tmp/user-checks/a.png"] },
        { criterion: "Streak bar glows", paths: ["/tmp/other/escape.png"] },
      ],
    }),
  ).toThrow(/outside the user-check directory/u);

  const resolved = resolveSubmittedReport(implementerJob("/repo"), {
    outcome: "implemented",
    report: "Added the streak bar.",
    userCheckEvidence: [{ criterion: "Streak bar glows", paths: ["/tmp/user-checks/a.png"] }],
  });
  expect(resolved.userCheckEvidence).toEqual([
    { criterion: "Streak bar glows", paths: ["/tmp/user-checks/a.png"] },
  ]);
});

test("resolveSubmittedReport refuses a relative userCheckEvidence path", () => {
  expect(() =>
    resolveSubmittedReport(implementerJob("/repo"), {
      outcome: "implemented",
      report: "Added the streak bar.",
      userCheckEvidence: [{ criterion: "Streak bar glows", paths: ["relative/a.png"] }],
    }),
  ).toThrow(/must be an absolute path/u);
});
