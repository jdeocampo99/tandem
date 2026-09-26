import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runChecked } from "../adapters/primitives.ts";
import { readHomeSettings, type SelfImprovementMode } from "../config/home-settings.ts";
import {
  type Clock,
  type CommandRunner,
  RESEARCH_CONTINUATION_SCHEMA_VERSION,
  type TaskRecord,
} from "../contracts.ts";
import { matchingRemote } from "../repos/locate.ts";
import {
  readMetadataPayload,
  withStateTransaction,
  writeMetadataPayload,
} from "../runtime/database.ts";
import {
  taskJobsDirectory,
  taskSessionDirectory,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type { CreateTaskRequest } from "../service/controller.ts";
import { isTerminalTask } from "../service/records.ts";
import { taskName } from "../tasks/question.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import type { TaskTrace } from "../tasks/trace.ts";
import {
  type DraftCheck,
  type IssueDraft,
  type IssueDraftChecker,
  scrubIssueDraft,
  TANDEM_REPOSITORY,
  workContentOf,
} from "./issue-draft.ts";
import { describeTrigger, investigationTrigger } from "./triggers.ts";

/** A task that broke a trigger rule, and the plain question the coordinator puts to the user. */
export type InvestigationQuestion = Readonly<{ readonly taskId: string; readonly text: string }>;

export type InvestigateInput = Readonly<{
  readonly taskId: string;
  /** The user's own question, when they asked; a trigger's investigation has none. */
  readonly question?: string | undefined;
  readonly targetCheckout?: string | undefined;
  readonly targetClone?: boolean | undefined;
}>;

/** A report-mode issue about one task, scrubbed of that task's work content. */
export type IssueInput = Readonly<{ readonly taskId: string }> & IssueDraft;

export type IssueReview = Readonly<{ readonly draft: IssueDraft; readonly check: DraftCheck }>;

export type SelfImprovementDependencies = Readonly<{
  readonly home: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly checkDraft: IssueDraftChecker;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  /** What `tandem trace TASK_ID --json` prints. */
  readonly traceTask: (taskId: string) => Promise<TaskTrace>;
  readonly createTask: (input: CreateTaskRequest) => Promise<TaskRecord>;
}>;

/** Task ids the user was already asked about, so each task is asked about once per home. */
const ASKED_KEY = "self_improvement_asked";

/**
 * Tandem looking into its own problems: asks about tasks that broke a trigger rule, starts the
 * research, and files the report-mode issue once the user approves it.
 */
export class SelfImprovement {
  constructor(private readonly deps: SelfImprovementDependencies) {}

  async mode(): Promise<SelfImprovementMode> {
    return (await readHomeSettings(this.deps.home)).selfImprovement;
  }

  /** Questions for open tasks that newly broke a rule; taking them marks them asked. */
  async takeQuestions(tasks: readonly TaskRecord[]): Promise<readonly InvestigationQuestion[]> {
    if ((await this.mode()) === "off") return [];
    const now = new Date(this.deps.clock());
    return withStateTransaction(this.deps.home, async (db) => {
      const asked = askedTaskIds(readMetadataPayload(db, ASKED_KEY));
      const questions: InvestigationQuestion[] = [];
      for (const task of tasks) {
        if (isTerminalTask(task) || asked.includes(task.id)) continue;
        const { events } = await readTimeline(this.deps.home, task.id);
        const trigger = investigationTrigger(events, now);
        if (trigger === undefined) continue;
        questions.push({
          taskId: task.id,
          text: `${taskName(task.objective)} ${describeTrigger(trigger)}. Want me to look into why?`,
        });
      }
      if (questions.length > 0) {
        writeMetadataPayload(db, ASKED_KEY, [...asked, ...questions.map(({ taskId }) => taskId)]);
      }
      return questions;
    });
  }

  /**
   * Starts research in the Tandem repository into why a task went the way it did. It writes the
   * task's record and trace to a file first, because research agents can read files but not run
   * commands.
   */
  async investigate(input: InvestigateInput): Promise<TaskRecord> {
    const mode = await this.requireMode();
    const task = await this.deps.getTask(input.taskId);
    const directory = join(this.deps.home, "investigations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tracePath = join(directory, `${task.id}.json`);
    const trace = await this.deps.traceTask(task.id);
    await writeTextAtomically(tracePath, `${JSON.stringify({ task, trace }, null, 2)}\n`);
    const inTandem =
      (await matchingRemote(task.repoPath, TANDEM_REPOSITORY, this.deps.run)) !== undefined;
    return this.deps.createTask({
      repoPath: task.repoPath,
      kind: "scout",
      objective: investigationObjective({
        task,
        question: input.question,
        mode,
        tracePath,
        sessionsPath: taskSessionDirectory(this.deps.home, task.id),
        jobsPath: taskJobsDirectory(this.deps.home, task.id),
      }),
      acceptanceCriteria: [
        "The report names the cause with evidence from the timeline, conversations, or source.",
        "The report proposes one change to Tandem that would prevent it, or says none is needed.",
      ],
      surfaces: ["tandem"],
      researchContinuation: {
        schemaVersion: RESEARCH_CONTINUATION_SCHEMA_VERSION,
        disposition: mode === "fix" ? "ask-intent" : "report-only",
        selectedBy: "explicit",
      },
      // Investigating from a coordinator in the Tandem checkout itself works in its own project.
      ...(inTandem ? {} : { targetRepo: TANDEM_REPOSITORY }),
      ...(input.targetCheckout === undefined ? {} : { targetCheckout: input.targetCheckout }),
      ...(input.targetClone === undefined ? {} : { targetClone: input.targetClone }),
    });
  }

  /** The scrubbed draft and its one Jev check, for the user to see before approving. */
  async reviewIssue(input: IssueInput): Promise<IssueReview> {
    await this.requireMode();
    const draft = await this.scrubbed(input);
    return { draft, check: await this.deps.checkDraft(draft) };
  }

  /**
   * Files exactly what `reviewIssue` showed: the scrub is deterministic, so the same input gives
   * the same text. Callers file only after the user approved it.
   */
  async fileIssue(input: IssueInput): Promise<Readonly<{ url: string }>> {
    await this.requireMode();
    const draft = await this.scrubbed(input);
    const result = await runChecked(
      this.deps.run,
      {
        argv: [
          "gh",
          "issue",
          "create",
          "--repo",
          TANDEM_REPOSITORY,
          "--title",
          draft.title,
          "--body-file",
          "-",
        ],
        cwd: this.deps.home,
        stdin: draft.body,
      },
      "github issue create",
    );
    return { url: result.stdout.trim() };
  }

  private async scrubbed(input: IssueInput): Promise<IssueDraft> {
    const task = await this.deps.getTask(input.taskId);
    return scrubIssueDraft({ title: input.title, body: input.body }, workContentOf(task));
  }

  private async requireMode(): Promise<Exclude<SelfImprovementMode, "off">> {
    const mode = await this.mode();
    if (mode === "off") {
      throw new Error(
        `Looking into Tandem's own problems is off on this machine. To turn it on, add selfImprovement = "fix" or "report" to ${join(this.deps.home, "settings.toml")}.`,
      );
    }
    return mode;
  }
}

/** What the research agent is asked to do, written for it rather than for the user. */
export function investigationObjective(
  input: Readonly<{
    readonly task: TaskRecord;
    readonly question: string | undefined;
    readonly mode: Exclude<SelfImprovementMode, "off">;
    readonly tracePath: string;
    readonly sessionsPath: string;
    readonly jobsPath: string;
  }>,
): string {
  const asked =
    input.question === undefined
      ? "It broke one of Tandem's trigger rules (two restarts, three fix rounds, or a block over an hour)."
      : `The user asked: ${input.question}`;
  const lines = [
    `Investigate why Tandem task ${input.task.id} went the way it did. ${asked} Find the cause in Tandem itself and the smallest change to Tandem that would prevent it.`,
    "Read:",
    `- ${input.tracePath}: the task's record and its trace, what tandem trace ${input.task.id} --json prints.`,
    `- ${input.sessionsPath}: its agents' conversations. Timeline events point at entries in them.`,
    `- ${input.jobsPath}: its agents' job files and reports.`,
    "- Tandem's source in this checkout.",
    "Report the cause with evidence (timeline events, conversation entries, source lines) and one proposed change, or say that none is needed.",
  ];
  if (input.mode === "report") {
    lines.push(
      `This machine files issues instead of changing Tandem. End the report with a "## Draft issue" section: a title line, then a body for an issue on ${TANDEM_REPOSITORY} with the diagnosis, the timeline events that show it, and the proposed change. Describe the task only by what Tandem did (stages, restarts, timings). Leave out the task's text, file paths, code, and names from the repository it worked in.`,
    );
  }
  return lines.join("\n");
}

function askedTaskIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
