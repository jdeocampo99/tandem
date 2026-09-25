import type { ModelSpec, RepoPolicy, ResolvedPolicy, TaskRecord } from "../../src/contracts.ts";

export const models: Readonly<
  Record<"coordinator" | "scout" | "implementer" | "reviewer" | "presentation", ModelSpec>
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

export const policyConfig: RepoPolicy = {
  version: 1,
  models,
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [],
  setupCommands: [],
  maxFixRounds: 3,
  reviewLevels: {
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  },
};

export const policy: ResolvedPolicy = {
  config: policyConfig,
  guidance: { implementation: [], validation: [], review: [] },
};

export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Implement the requested change",
    acceptanceCriteria: ["Keep the durable behavior intact."],
    surfaces: ["src/extension.ts"],
    stage: "ready",
    scopeApproved: true,
    policy,
    createdAt: "2030-01-02T03:04:05.000Z",
    updatedAt: "2030-01-02T03:04:05.000Z",
    generation: 0,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}
