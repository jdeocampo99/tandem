import type { QuickScopeReport, TaskRecord } from "../../src/contracts.ts";
import { createTask } from "../../src/tasks/lifecycle.ts";
import { quickApproval, quickTaskTitle } from "../../src/tasks/quick.ts";
import { SCENARIO_NOW, SCENARIO_POLICY } from "../evals/scenario.ts";

export const TEXT = "Rename the Save button to Save draft on the settings page";
export const SCOPE: QuickScopeReport = {
  files: 14,
  areas: ["billing", "the settings page", "the CLI"],
  decision: "whether drafts expire",
  plan: "split it into a request with a brief",
};

export function quickTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask(
      {
        id: "task-q1",
        repoPath: "/work/project",
        kind: "implementation",
        objective: TEXT,
        title: quickTaskTitle(TEXT),
        acceptanceCriteria: [],
        surfaces: ["*"],
        policy: SCENARIO_POLICY,
        quick: quickApproval({ text: TEXT, at: SCENARIO_NOW }),
      },
      SCENARIO_NOW,
    ),
    ...overrides,
  };
}
