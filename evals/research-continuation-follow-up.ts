import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResearchContinuation, ResolvedPolicy } from "../src/contracts.ts";
import { buildResearchFollowUpContent } from "../src/session/research-follow-up.ts";
import { transitionTask } from "../src/tasks/lifecycle.ts";
import {
  decideResearchFollowUp,
  type ResearchFollowUpDecision,
  type ResearchFollowUpInput,
} from "../src/tasks/research-continuation.ts";
import { createTaskStore } from "../src/tasks/store.ts";
import type { ResearchContinuationFixture } from "./research-continuation-fixtures.ts";
import { createEphemeralHome, type EphemeralHome } from "./run-jev.ts";

const NOW = "2030-01-02T03:04:05.000Z";
const IMPLEMENTATION_APPROVAL_DISCLAIMER = "its own confirmation is the single approval ask";

type FollowUpTask = ResearchFollowUpInput["task"];

/** Builds the scout state `decideResearchFollowUp` should see for a fixture's `scoutOutcome`. */
function followUpTaskFor(
  fixture: ResearchContinuationFixture,
  researchContinuation: ResearchContinuation,
): FollowUpTask {
  const base = { kind: "scout" as const, researchContinuation };
  switch (fixture.scoutOutcome) {
    case "completed":
      return { ...base, stage: "completed", generation: 0, reportPath: "/reports/fixture.md" };
    case "blocked":
      return { ...base, stage: "blocked", generation: 0, reportPath: "/reports/fixture.md" };
    case "cancelled":
      return { ...base, stage: "cancelled", generation: 0, reportPath: "/reports/fixture.md" };
    case "needs-decision":
      return {
        ...base,
        stage: "completed",
        generation: 0,
        reportPath: "/reports/fixture.md",
        communication: {
          revision: 1,
          messages: [],
          question: { id: "decision-question", text: "Which fix direction should we pursue?" },
        },
      };
    case "missing-report":
      return { ...base, stage: "completed", generation: 0 };
    case "stale-generation":
      return { ...base, stage: "completed", generation: 1, reportPath: "/reports/fixture.md" };
  }
}

const FIXTURE_POLICY: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
      scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxWorkers: 3,
    maxFixRounds: 3,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

/**
 * Builds the completed scout on disk, decides its follow-up, then rebuilds it from a fresh task
 * store instance over the same directory and decides again, so a restart or compaction between
 * scout completion and coordinator follow-up is proven to reproduce identical content.
 */
async function decideRestartedFollowUp(
  fixture: ResearchContinuationFixture,
  researchContinuation: ResearchContinuation,
): Promise<
  Readonly<{ decision: ResearchFollowUpDecision; content: string; restartContent: string }>
> {
  const { home, cleanup }: EphemeralHome = await createEphemeralHome();
  try {
    const directory = join(home, "tasks");
    const reportPath = join(home, "jobs", "scout-task", "0", "job-1", "report.txt");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `Outcome: completed\n${fixture.description}\n`, "utf8");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const created = await store.create({
      id: "scout-task",
      repoPath: join(home, "repo"),
      kind: "scout",
      objective: fixture.objective,
      acceptanceCriteria: ["Report the findings"],
      surfaces: ["src"],
      policy: FIXTURE_POLICY,
      researchContinuation,
    });
    const scouting = await store.update(created.id, created.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: NOW,
      stage: "scouting",
    }));
    await store.update(scouting.id, scouting.revision, (current) =>
      transitionTask(
        current,
        { type: "scout-report-complete", generation: current.generation, reportPath },
        { now: NOW, notificationId: "scout-complete" },
      ),
    );

    const first = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const firstRecord = await first.read("scout-task");
    if (firstRecord === undefined)
      throw new Error(`fixture ${fixture.id}: scout was not persisted`);
    const decision = decideResearchFollowUp({ task: firstRecord, reportReadable: true });
    const content = buildResearchFollowUpContent(decision);

    const restarted = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const restartedRecord = await restarted.read("scout-task");
    if (restartedRecord === undefined) {
      throw new Error(`fixture ${fixture.id}: scout did not survive the simulated restart`);
    }
    const restartContent = buildResearchFollowUpContent(
      decideResearchFollowUp({ task: restartedRecord, reportReadable: true }),
    );
    return { decision, content, restartContent };
  } finally {
    await cleanup();
  }
}

function checkContent(fixture: ResearchContinuationFixture, content: string): string[] {
  const failures: string[] = [];
  for (const needle of fixture.contentMustContain) {
    if (!content.includes(needle)) failures.push(`missing required text: ${needle}`);
  }
  for (const needle of fixture.contentMustNotContain) {
    if (content.includes(needle)) failures.push(`contains forbidden text: ${needle}`);
  }
  return failures;
}

/**
 * True only when an interview follow-up is rendered without carrying its own approval disclaimer.
 * A false or missed interview classification is a quality miss, tracked separately; this flags the
 * one way this pure, non-authorizing content could itself misrepresent the safety invariant.
 */
function hasSafetyFailure(decision: ResearchFollowUpDecision, content: string): boolean {
  return (
    decision.followUp === "implementation-interview" &&
    !content.includes(IMPLEMENTATION_APPROVAL_DISCLAIMER)
  );
}

export async function evaluateFixtureFollowUp(
  fixture: ResearchContinuationFixture,
  continuation: ResearchContinuation,
) {
  let decision: ResearchFollowUpDecision;
  let content: string;
  let restartContent: string | undefined;
  if (fixture.restartCheck === true) {
    ({ decision, content, restartContent } = await decideRestartedFollowUp(fixture, continuation));
  } else {
    const task = followUpTaskFor(fixture, continuation);
    const notifiedGeneration = fixture.scoutOutcome === "stale-generation" ? 0 : undefined;
    decision = decideResearchFollowUp({
      task,
      reportReadable: true,
      ...(notifiedGeneration === undefined ? {} : { notifiedGeneration }),
    });
    content = buildResearchFollowUpContent(decision);
  }
  const contentFailures = checkContent(fixture, content);
  if (restartContent !== undefined && restartContent !== content) {
    contentFailures.push("restart content diverged from the original decision");
  }
  return {
    decision,
    content,
    restartContent,
    contentFailures,
    safetyFailure: hasSafetyFailure(decision, content),
  };
}
