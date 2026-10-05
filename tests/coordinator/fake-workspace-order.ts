import { join } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  ResolvedPolicy,
} from "../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

type WorkspaceMove = Readonly<{
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly insertIndex: number;
}>;

export const SESSION = "tandem";

/**
 * A fake Herdr sidebar: an ordered list of workspace ids that `workspace list` reports and
 * `workspace.move` reorders with Herdr's real rule (insert before the workspace at that index in
 * the list as it was before the move). Every move and every other command is recorded.
 */
export type FakeSidebar = Readonly<{
  readonly order: string[];
  readonly moves: WorkspaceMove[];
  readonly calls: CommandRequest[];
  readonly run: CommandRunner;
  readonly moveWorkspace: (request: WorkspaceMove) => Promise<unknown>;
  /** When set, `workspace.move` rejects with this message instead of moving anything. */
  fail: (message: string | undefined) => void;
}>;

export function fakeSidebar(
  initial: readonly string[],
  labels: Readonly<Record<string, string>> = {},
): FakeSidebar {
  const order = [...initial];
  const moves: WorkspaceMove[] = [];
  const calls: CommandRequest[] = [];
  let failure: string | undefined;
  const ok = (value: unknown): CommandResult => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  });
  const list = () => ({
    result: {
      type: "workspace_list",
      workspaces: order.map((id) => ({ workspace_id: id, label: labels[id] ?? `workspace ${id}` })),
    },
  });
  return {
    order,
    moves,
    calls,
    run: async (request) => {
      calls.push(request);
      const args = request.argv.slice(3);
      if (request.argv[0] === "herdr" && args[0] === "status") {
        return ok({ server: { socket: "/tmp/fake-herdr.sock", running: true, session: SESSION } });
      }
      if (request.argv[0] === "herdr" && args[0] === "workspace" && args[1] === "list") {
        return ok(list());
      }
      throw new Error(`unexpected command ${request.argv.join(" ")}`);
    },
    moveWorkspace: async (request) => {
      if (failure !== undefined) throw new Error(failure);
      moves.push(request);
      const from = order.indexOf(request.workspaceId);
      const before = order[request.insertIndex];
      order.splice(from, 1);
      const at = before === undefined ? order.length : order.indexOf(before);
      order.splice(at, 0, request.workspaceId);
      return list();
    },
    fail: (message) => {
      failure = message;
    },
  };
}

const policy: ResolvedPolicy = {
  config: defaultPolicy(),
  guidance: { implementation: [], validation: [], review: [] },
};

export async function saveCoordinator(
  home: string,
  repoPath: string,
  workspaceId: string,
): Promise<void> {
  await saveCoordinatorRecord(home, {
    schemaVersion: 1,
    repoPath,
    endpoint: {
      sessionId: SESSION,
      workspaceId,
      tabId: `tab-${workspaceId}`,
      paneId: `pane-${workspaceId}`,
      role: "coordinator",
      generation: 0,
    },
    worktree: {
      root: join(repoPath, "..", "pool"),
      path: join(repoPath, "..", "pool", workspaceId),
      name: workspaceId,
      baseHead: "abc123",
      branch: `tandem/${workspaceId}`,
      leaseId: `lease-${workspaceId}`,
      leaseHolder: "coordinator",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    harness: DEFAULT_HARNESS,
    command: ["omp"],
  });
}

/** Seeds tasks, oldest first, each with a durable endpoint in its own workspace. */
export async function seedTasks(
  home: string,
  tasks: readonly Readonly<{ id: string; repoPath: string; workspaceId: string }>[],
  presentations: readonly Readonly<{ id: string; taskId: string; workspaceId: string }>[] = [],
): Promise<void> {
  const runtimeTasks = [];
  for (const [index, task] of tasks.entries()) {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => `2030-01-0${index + 1}T00:00:00.000Z`,
      idFactory: () => task.id,
    });
    await store.create({
      id: task.id,
      repoPath: task.repoPath,
      kind: "implementation",
      objective: `TAG-1036 attempt ${index + 1}`,
      acceptanceCriteria: ["done"],
      surfaces: ["service"],
      policy,
    });
    const endpoint: Endpoint = {
      sessionId: SESSION,
      workspaceId: task.workspaceId,
      tabId: `tab-${task.id}`,
      paneId: `pane-${task.id}`,
      role: "implementer",
      generation: 0,
    };
    runtimeTasks.push({
      schemaVersion: 1 as const,
      taskId: task.id,
      sourceCheckpoint: { head: "abc123", base: "abc123", diff: "", dirty: false, unmerged: false },
      taskName: task.id,
      endpoints: [endpoint],
      jobs: [],
    });
  }
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: runtimeTasks,
    presentations: presentations.map((presentation) => ({
      schemaVersion: 1 as const,
      id: presentation.id,
      taskId: presentation.taskId,
      recordPath: join(home, "presentations", presentation.id, "record.json"),
      endpoint: {
        sessionId: SESSION,
        workspaceId: presentation.workspaceId,
        tabId: `tab-${presentation.id}`,
        paneId: `pane-${presentation.id}`,
        role: "presentation" as const,
        generation: 0,
      },
    })),
  });
}
