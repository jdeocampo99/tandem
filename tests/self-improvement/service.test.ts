import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, TaskRecord } from "../../src/contracts.ts";
import type { IssueDraft } from "../../src/self-improvement/issue-draft.ts";
import { SelfImprovement } from "../../src/self-improvement/service.ts";
import type { CreateTaskRequest } from "../../src/service/controller.ts";
import { readTimeline, recordTimelineEvents } from "../../src/tasks/timeline-store.ts";
import { task } from "../session/fixtures.ts";

const NOW = "2030-01-02T12:00:00.000Z";

async function withHome(
  mode: string | undefined,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tandem-self-improvement-"));
  try {
    if (mode !== undefined) {
      await writeFile(join(home, "settings.toml"), `selfImprovement = "${mode}"\n`);
    }
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function selfImprovement(
  home: string,
  tasks: readonly TaskRecord[],
  effects: Readonly<{
    created?: CreateTaskRequest[];
    commands?: CommandRequest[];
    checked?: IssueDraft[];
  }> = {},
): SelfImprovement {
  return new SelfImprovement({
    home,
    clock: () => NOW,
    run: async (request) => {
      effects.commands?.push(request);
      return request.argv[0] === "gh"
        ? { code: 0, stdout: "https://github.com/jdeocampo99/tandem/issues/7\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "not a git repository" };
    },
    checkDraft: async (draft) => {
      effects.checked?.push(draft);
      return { flagged: true, warning: "It may still contain work code, paths, or secrets." };
    },
    getTask: async (taskId) => {
      const found = tasks.find((candidate) => candidate.id === taskId);
      if (found === undefined) throw new Error(`Task ${taskId} was not found`);
      return found;
    },
    traceTask: async (taskId) => ({
      ...(await readTimeline(home, taskId)),
      rollup: { taskId, fixRounds: 0, blockedMs: 0 },
    }),
    createTask: async (input) => {
      effects.created?.push(input);
      return task({ id: "task-investigation", kind: "scout", stage: "queued" });
    },
  });
}

async function restartTwice(home: string, taskId: string): Promise<void> {
  const restart = {
    taskId,
    at: "2030-01-02T10:00:00.000Z",
    type: "restarted",
    role: "worker",
    attempt: 1,
  } as const;
  await recordTimelineEvents(home, [restart, { ...restart, attempt: 2 }]);
}

test("a task that restarted twice is asked about once, and never while the mode is off", async () => {
  const open = task({ id: "task-open", objective: "Fix the login page", stage: "implementing" });
  const finished = task({ id: "task-done", stage: "completed" });
  await withHome(undefined, async (home) => {
    await restartTwice(home, open.id);
    expect(await selfImprovement(home, [open]).takeQuestions([open])).toEqual([]);
  });
  await withHome("fix", async (home) => {
    await restartTwice(home, open.id);
    await restartTwice(home, finished.id);
    const service = selfImprovement(home, [open, finished]);
    expect(await service.takeQuestions([open, finished])).toEqual([
      {
        taskId: "task-open",
        text: '"Fix the login page" has restarted twice. Want me to look into why?',
      },
    ]);
    expect(await service.takeQuestions([open, finished])).toEqual([]);
  });
});

test("investigating writes the task's trace to a file and starts research in Tandem", async () => {
  const investigated = task({ id: "task-open", objective: "Fix the login page" });
  await withHome("report", async (home) => {
    await restartTwice(home, investigated.id);
    const created: CreateTaskRequest[] = [];
    await selfImprovement(home, [investigated], { created }).investigate({
      taskId: investigated.id,
      question: "why did the login fix take so long?",
    });
    const [research] = created;
    expect(research).toMatchObject({
      repoPath: investigated.repoPath,
      kind: "scout",
      targetRepo: "jdeocampo99/tandem",
      researchContinuation: { disposition: "report-only", selectedBy: "explicit" },
    });
    const tracePath = join(home, "investigations", "task-open.json");
    expect(research?.objective).toContain(tracePath);
    expect(research?.objective).toContain(join(home, "sessions", "task-open"));
    expect(research?.objective).toContain("The user asked: why did the login fix take so long?");
    expect(research?.objective).toContain('"## Draft issue"');
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    expect(trace.task.id).toBe("task-open");
    expect(trace.trace.events.map((event: { type: string }) => event.type)).toEqual([
      "restarted",
      "restarted",
    ]);
  });
  await withHome(undefined, async (home) => {
    await expect(
      selfImprovement(home, [investigated]).investigate({ taskId: investigated.id }),
    ).rejects.toThrow('add selfImprovement = "fix" or "report"');
  });
});

test("a report-mode issue is scrubbed, checked once for review, and filed exactly as shown", async () => {
  const investigated = task({
    id: "task-open",
    repoPath: "/Users/me/Coding/acme-billing",
    objective: "Charge the late fee on overdue invoices.",
  });
  await withHome("report", async (home) => {
    const commands: CommandRequest[] = [];
    const checked: IssueDraft[] = [];
    const service = selfImprovement(home, [investigated], { commands, checked });
    const input = {
      taskId: investigated.id,
      title: "Reviewer times out on acme-billing",
      body: "It stalled in /Users/me/Coding/acme-billing/src/fees.ts.",
    };
    const review = await service.reviewIssue(input);
    expect(review.draft).toEqual({
      title: "Reviewer times out on (project name removed)",
      body: "It stalled in (path removed).",
    });
    expect(review.check.flagged).toBe(true);
    expect(checked).toEqual([review.draft]);

    expect(await service.fileIssue(input)).toEqual({
      url: "https://github.com/jdeocampo99/tandem/issues/7",
    });
    const filed = commands.find((command) => command.argv[0] === "gh");
    expect(filed?.argv).toEqual([
      "gh",
      "issue",
      "create",
      "--repo",
      "jdeocampo99/tandem",
      "--title",
      review.draft.title,
      "--body-file",
      "-",
    ]);
    expect(filed?.stdin).toBe(review.draft.body);
  });
});
