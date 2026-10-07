import { expect, test } from "bun:test";
import type { TaskCommunication, TaskInbox, WorkerReceipt } from "../../../src/contracts.ts";
import { ClaudeCodePane } from "../../../src/harness/claude-code/host.ts";
import type { SidecarLine } from "../../../src/harness/claude-code/plugins/tandem/hooks/protocol.ts";
import { claudeCodeWorker } from "../../../src/harness/claude-code/worker.ts";
import { WorkerSession } from "../../../src/session/worker.ts";
import { WorkerSteering } from "../../../src/session/worker-steering.ts";
import {
  appendTaskMessage,
  formatTaskMessages,
  taskInbox,
} from "../../../src/tasks/communication-protocol.ts";
import type { WorkerJob, WorkerResult } from "../../../src/workers/jobs.ts";
import type { WorkerTerminalCommand, WorkerTerminalState } from "../../../src/workers/terminal.ts";
import type { WorkerActivity } from "../../../src/workers/worker-activity.ts";
import { fakeSessionTime } from "../../evals/scenario.ts";

const TASK = "task-1";
const BRIEF = "Look at the cache.";

function inboxWith(count: number): TaskInbox {
  let communication: TaskCommunication | undefined;
  for (let index = 1; index <= count; index += 1) {
    communication = appendTaskMessage(communication, {
      id: `direction-${index}`,
      kind: "instruction",
      text: `Direction ${index}.`,
      createdAt: "2030-01-02T03:04:05.000Z",
    });
  }
  if (communication === undefined) throw new Error("no communication");
  return taskInbox(TASK, communication);
}

/** A Claude Code worker over a real session and steering, with fake files and clocks. */
async function worker(role: WorkerJob["role"] = "scout", extra: Partial<WorkerJob> = {}) {
  const time = fakeSessionTime();
  const lines: SidecarLine[] = [];
  const pane = new ClaudeCodePane({
    write: (line) => lines.push(line),
    confirm: async () => false,
    startsWithPrompt: true,
  });
  const files: {
    inbox: TaskInbox | undefined;
    command: WorkerTerminalCommand | undefined;
    receipts: WorkerReceipt[];
    activities: WorkerActivity[];
    states: WorkerTerminalState[];
    results: WorkerResult[];
  } = {
    inbox: undefined,
    command: undefined,
    receipts: [],
    activities: [],
    states: [],
    results: [],
  };
  const job = {
    schemaVersion: 1,
    id: "job-1",
    taskId: TASK,
    generation: 0,
    role,
    cwd: "/tmp/worktree",
    harness: "claude-code",
    model: { model: "claude-code/sonnet", thinking: "low" },
    prompt: BRIEF,
    resultPath: "/tmp/result.json",
    ...extra,
  } as WorkerJob;
  const session = new WorkerSession({
    host: pane.host,
    clock: time.clock,
    timers: time.timers,
    status: undefined,
    job,
    pid: 1,
    terminal: {
      readCommand: async () => files.command,
      writeState: async (state) => {
        files.states.push(state);
      },
      writeTokenTally: async () => undefined,
    },
    persistResult: async (result) => {
      files.results.push(result);
    },
    readReceipt: async () => files.receipts.at(-1),
    gitStatus: async () => "",
    gitHead: async () => "base-head",
    readFile: async () => "",
    copyAsset: async (input) => `${input.artifactDir}/${input.name}`,
    trace: () => undefined,
  });
  const steering = await WorkerSteering.open({
    host: pane.host,
    clock: time.clock,
    timers: time.timers,
    delivery: "messages",
    config: {
      schemaVersion: 1,
      jobId: "job-1",
      taskId: TASK,
      generation: 0,
      inboxPath: "/tmp/inbox.json",
      receiptPath: "/tmp/receipt.json",
      initialRevision: 0,
    },
    readInbox: async () => files.inbox,
    writeReceipt: async (receipt) => {
      files.receipts.push(receipt);
    },
    writeActivity: async (activity) => {
      files.activities.push(activity);
    },
    trace: () => undefined,
  });
  const binding = claudeCodeWorker(pane, { job, session, steering, trace: () => undefined });
  await binding.handle({ type: "sessionStart", model: "claude-sonnet-5-5" });
  return { binding, pane, session, files, lines, time };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

const read = { id: "t1", name: "Read", input: { file_path: "src/a.ts" } };

test("steering that arrives mid-turn rides after the next tool result, once", async () => {
  const { binding, files } = await worker();
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await binding.handle({ type: "toolStart", call: read });
  expect(await binding.handle({ type: "toolEnd", call: read })).toEqual({
    type: "toolContext",
    context: [],
  });

  files.inbox = inboxWith(1);
  const steer = formatTaskMessages(TASK, 1, inboxWith(1).messages);
  expect(await binding.handle({ type: "toolEnd", call: read })).toEqual({
    type: "toolContext",
    context: [steer],
  });
  expect(files.receipts.at(-1)).toMatchObject({ appliedRevision: 1 });
  expect(await binding.handle({ type: "toolEnd", call: read })).toEqual({
    type: "toolContext",
    context: [],
  });
  expect(await binding.handle({ type: "stopRequested", aborted: false })).toEqual({
    type: "stop",
  });
});

test("steering that arrives as the turn ends keeps the worker going with it", async () => {
  const { binding, files } = await worker();
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  files.inbox = inboxWith(2);
  expect(await binding.handle({ type: "stopRequested", aborted: false })).toEqual({
    type: "stop",
    continueWith: formatTaskMessages(TASK, 2, inboxWith(2).messages),
  });
  expect(files.receipts.at(-1)).toMatchObject({ receivedRevision: 2, appliedRevision: 2 });
});

test("an idle worker gets steering as a submitted prompt, after its brief has run", async () => {
  const { binding, files, lines, time } = await worker();
  files.inbox = inboxWith(1);
  time.advance(250);
  await settle();
  // The brief is still queued, so nothing is submitted over it.
  expect(lines.filter((line) => line.type === "submit")).toEqual([]);

  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await binding.handle({
    type: "pluginTool",
    id: "t2",
    name: "submit_report",
    input: { outcome: "completed", report: "Keyed by path." },
  });
  await binding.handle({ type: "agentEnd", interrupted: false });
  time.advance(250);
  await settle();
  const steer = formatTaskMessages(TASK, 1, inboxWith(1).messages);
  expect(lines.filter((line) => line.type === "submit")).toEqual([{ type: "submit", text: steer }]);
});

test("the brief is Tandem's; a prompt the person types is theirs", async () => {
  const { binding, files } = await worker();
  await binding.handle({ type: "userPrompt", text: BRIEF, origin: "composer", attachments: 0 });
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await binding.handle({ type: "agentEnd", interrupted: false });
  // A turn Tandem started that ended without a report is reminded, not conversation.
  expect(files.results).toEqual([]);
  expect(files.states.at(-1)?.phase).toBe("idle");

  const typed = await worker();
  await typed.binding.handle({
    type: "userPrompt",
    text: "What did you find?",
    origin: "composer",
    attachments: 0,
  });
  await typed.binding.handle({ type: "agentStart", prompt: "What did you find?" });
  await typed.binding.handle({ type: "agentEnd", interrupted: false });
  expect(typed.lines.filter((line) => line.type === "submit")).toEqual([]);
});

test("a background task's notification after the report is dropped; before it, and a typed prompt after it, still run", async () => {
  const { binding } = await worker();
  const notice = {
    type: "userPrompt",
    text: "Background task finished.",
    origin: "task-notification",
    attachments: 0,
  } as const;
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  expect(await binding.handle(notice)).toEqual({ type: "promptRoute", handled: false });
  await binding.handle({
    type: "pluginTool",
    id: "t2",
    name: "submit_report",
    input: { outcome: "completed", report: "Keyed by path." },
  });
  await binding.handle({ type: "agentEnd", interrupted: false });
  expect(await binding.handle(notice)).toEqual({ type: "promptRoute", handled: true });
  expect(
    await binding.handle({
      type: "userPrompt",
      text: "What did you find?",
      origin: "composer",
      attachments: 0,
    }),
  ).toEqual({ type: "promptRoute", handled: false });
});

test("submit_report runs through the guard, and a TodoWrite list reaches the playbook gate", async () => {
  const { binding, files } = await worker("scout");
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  const report = await binding.handle({
    type: "pluginTool",
    id: "t2",
    name: "submit_report",
    input: { outcome: "completed", report: "Keyed by path." },
  });
  expect(report).toEqual({
    type: "toolResult",
    text: "Report submitted with status completed.",
    isError: false,
  });
  expect(files.results).toHaveLength(1);
  const again = await binding.handle({
    type: "pluginTool",
    id: "t3",
    name: "submit_report",
    input: { outcome: "completed", report: "Again." },
  });
  expect(again).toMatchObject({ type: "toolResult", isError: true });
  expect(files.results).toHaveLength(1);
  expect(
    await binding.handle({ type: "pluginTool", id: "t4", name: "tandem", input: {} }),
  ).toMatchObject({ type: "toolResult", isError: true });
});

test("while the pane closes, the person's edits are held back", async () => {
  const { binding, files, time } = await worker();
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await binding.handle({
    type: "pluginTool",
    id: "t2",
    name: "submit_report",
    input: { outcome: "completed", report: "Keyed by path." },
  });
  await binding.handle({ type: "agentEnd", interrupted: false });
  expect(await binding.handle({ type: "promptEdit", draft: true })).toEqual({
    type: "editDecision",
    allowed: true,
  });
  await binding.handle({ type: "promptEdit", draft: false });

  files.command = {
    schemaVersion: 1,
    id: "close-1",
    jobId: "job-1",
    taskId: TASK,
    generation: 0,
    action: "close",
    expiresAt: new Date(time.clock.now() + 60_000).toISOString(),
  };
  time.advance(250);
  await settle();
  expect(files.states.at(-1)?.phase).toBe("closing");
  expect(await binding.handle({ type: "promptEdit", draft: true })).toEqual({
    type: "editDecision",
    allowed: false,
  });
});

test("a reviewer cannot edit, write, or run a shell command", async () => {
  const { binding } = await worker("reviewer");
  for (const call of [
    { id: "e", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } },
    { id: "w", name: "Write", input: { file_path: "a.ts", content: "x" } },
    { id: "b", name: "Bash", input: { command: "git commit -am x" } },
  ]) {
    expect(await binding.handle({ type: "toolCall", call })).toEqual({
      type: "toolDecision",
      block: true,
      reason: "A reviewer only reads: it cannot edit files or run commands.",
    });
  }
  expect(await binding.handle({ type: "toolCall", call: read })).toEqual({
    type: "toolDecision",
    block: false,
  });
});

test("an implementer's edits stop once its report is in, as on OMP", async () => {
  const { binding, session } = await worker("implementer");
  const edit = { id: "e", name: "Edit", input: { file_path: "a.ts" } };
  expect(await binding.handle({ type: "toolCall", call: edit })).toEqual({
    type: "toolDecision",
    block: false,
  });
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await session.submitReport({ outcome: "implemented", report: "Done." });
  expect(await binding.handle({ type: "toolCall", call: edit })).toEqual({
    type: "toolDecision",
    block: true,
    reason: "worker terminal is paused or completed; mutating tools are disabled",
  });
});

test("an implementer's playbook steps count as done once Claude Code's task tools mark them, even paraphrased", async () => {
  const { binding, files } = await worker("implementer", {
    playbookSteps: ["Look for code to reuse or dead code to delete"],
  });
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  const report = {
    type: "pluginTool",
    id: "r",
    name: "submit_report",
    input: { outcome: "implemented", report: "Done." },
  } as const;
  expect(await binding.handle(report)).toMatchObject({
    isError: true,
    text: expect.stringContaining('"1. Look for code to reuse or dead code to delete"'),
  });
  const create = {
    id: "c",
    name: "TaskCreate",
    input: { subject: "1. Reuse check", description: "Look for code to reuse" },
  };
  await binding.handle({ type: "toolStart", call: create });
  await binding.handle({ type: "toolEnd", call: create, result: { task: { id: "1" } } });
  const done = { id: "u", name: "TaskUpdate", input: { taskId: "1", status: "completed" } };
  await binding.handle({ type: "toolStart", call: done });
  await binding.handle({ type: "toolEnd", call: done });
  expect(await binding.handle(report)).toMatchObject({ isError: false });
  expect(files.results).toHaveLength(1);
});

test("the activity file gets the running tool's target and the task list; the receipt stays as it was", async () => {
  const { binding, files } = await worker("implementer");
  await binding.handle({ type: "agentStart", prompt: BRIEF });
  await binding.handle({ type: "toolStart", call: read });
  await settle();
  expect(files.activities.at(-1)).toMatchObject({ tool: "Read", toolTarget: "src/a.ts" });
  expect(files.receipts.at(-1)).toMatchObject({ phase: "tool", tool: "Read" });
  expect(files.receipts.at(-1)).not.toContainKey("toolTarget");
  await binding.handle({ type: "toolEnd", call: read });
  await settle();
  expect(files.activities.at(-1)).toEqual({});

  const create = { id: "c", name: "TaskCreate", input: { subject: "Write the test" } };
  await binding.handle({ type: "toolStart", call: create });
  await binding.handle({ type: "toolEnd", call: create, result: { task: { id: "1" } } });
  await settle();
  expect(files.activities.at(-1)).toEqual({
    todos: [{ content: "Write the test", status: "pending" }],
  });
});
