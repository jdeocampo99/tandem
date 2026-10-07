import { z } from "zod";
import { SETUP_MODES, SETUP_SECTIONS, type SetupMode } from "../onboarding/setup-view.ts";

/**
 * Each view file's model holds what its screens draw. These schemas are the only statement of
 * that shape: `store.ts` validates every model before writing it, and the screens index the
 * model without parsing it. Luau reads JSON `null` as an absent field, so optional is nullish.
 */
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish();
const str = z.string();
const num = z.number().finite();
const bool = z.boolean();
const strings = z.array(str);

const PanelTarget = z.object({
  kind: str,
  taskId: opt(str),
  requestId: opt(str),
  repo: opt(str),
  number: opt(num),
});
const PanelRow = z.object({
  key: str,
  title: str,
  state: str,
  stage: str,
  time: opt(str),
  model: opt(str),
  detail: opt(str),
  secondary: str,
  target: PanelTarget,
  pullRequest: opt(z.object({ number: num, url: str })),
});
const ProjectRow = z.object({
  repoPath: str,
  name: str,
  status: str,
  current: bool,
  offline: bool,
  needsYou: num,
  shortcut: opt(str),
});
const Panel = z.object({
  header: z.object({
    title: str,
    otherProjectsNeedYou: num,
    bellCount: num,
    fiveHourLabel: str,
    fiveHour: opt(z.object({ remainingPercent: z.union([num, str]) })),
    projects: z.array(ProjectRow),
  }),
  sections: z.array(z.object({ title: str, count: num, rows: z.array(PanelRow) })),
  footer: opt(str),
});
const BoardCard = z.object({
  key: str,
  title: str,
  detail: str,
  stuck: bool,
  branch: opt(str),
  time: opt(str),
  model: opt(str),
  costLabel: opt(str),
  harnessGlyph: opt(str),
  pullRequest: opt(z.object({ number: num, draft: bool, url: str })),
});
const Board = z.object({
  viewOnly: z.literal(true),
  returnLabel: str,
  lanes: z.array(z.object({ title: str, count: num, cards: z.array(BoardCard) })).length(4),
});
const Meter = z.object({
  label: str,
  remaining: str,
  reset: str,
  fetched: str,
  percent: opt(num),
});
const ModelCost = z.object({ model: str, cost: str, percent: num });
const Usage = z.object({
  display: z.object({
    accounts: z.array(z.object({ title: str, meters: z.array(Meter) })),
    totals: z.array(z.object({ label: str, value: str })),
    todayModels: z.array(ModelCost),
    weekModels: z.array(ModelCost),
    stages: z.array(z.object({ label: str, today: str, week: str })),
    updated: str,
    limitWarnings: strings,
    warning: opt(str),
  }),
});
const CatchUp = z.object({
  merged: z.array(z.object({ number: num, title: str, url: str })),
  needsYou: z.array(z.object({ key: str, name: str, text: str })),
  blocked: z.array(z.object({ key: str, name: str, reason: str })),
  whereWeLeftOff: z.array(z.object({ workstream: str, text: str })),
});
const DetailFile = str.regex(/^[\w%.-]+\.json$/u);
const IndexModel = z.object({
  project: str,
  panel: Panel,
  board: Board,
  usage: Usage,
  catchup: CatchUp,
  tasks: z.record(
    z.object({ taskId: str.regex(/^[\w-]+$/u), title: str, stage: str, model: opt(str) }),
  ),
  briefs: z.record(z.object({ detailFile: DetailFile })),
  pullRequests: z.record(
    z.object({
      header: z.object({ number: num, title: str, repo: str, taskId: opt(str) }),
      detailFile: DetailFile,
    }),
  ),
});

const TimelineEvent = z.object({
  seq: num,
  at: str,
  type: str,
  cause: opt(str),
  from: opt(str),
  to: opt(str),
  stage: opt(str),
  round: opt(num),
});
const Charges = z.object({ amountMicros: num, unavailableSamples: num });
const Tokens = z.object({
  actualInputTokens: num,
  actualOutputTokens: num,
  estimatedInputTokens: num,
  estimatedOutputTokens: num,
  unavailableSamples: num,
});
const Duration = z.union([num, z.literal("unavailable")]);
const TaskModel = z.object({
  header: z.object({
    id: str.regex(/^[\w-]+$/u),
    title: str,
    stage: str,
    elapsed: str,
    returnLabel: str,
    model: opt(str),
    branch: opt(str),
  }),
  rightNow: z.object({ text: str, age: opt(str) }),
  stageTrack: z.array(
    z.object({
      label: str,
      state: z.enum(["done", "current", "pending", "skipped"]),
      round: opt(z.object({ used: num, max: num })),
    }),
  ),
  tabs: strings,
  overview: z.object({
    summary: str,
    todos: z.array(z.object({ content: str, status: str })),
    done: num,
    total: num,
    recent: z.array(TimelineEvent),
  }),
  progress: z.object({
    events: z.array(TimelineEvent),
    unreadableEvents: num,
    checks: z.array(z.object({ name: str, passed: bool, head: str, contract: str })),
    findings: z.array(
      z.object({
        id: str,
        severity: str,
        description: str,
        status: str,
        file: opt(str),
        line: opt(num),
      }),
    ),
  }),
  stuck: opt(z.object({ reason: str })),
  requestId: opt(str),
  pullRequest: opt(z.object({ number: num })),
  message: z.object({ placeholder: str, model: opt(str) }),
  cost: opt(
    z.object({
      recorded: bool,
      charges: Charges,
      tokens: Tokens,
      timing: z.object({ elapsedMs: Duration, activeMs: num, waitingMs: Duration }),
      quota: z.object({
        entries: z.array(z.object({ plan: str, units: num, unit: str })),
        unavailableSamples: num,
      }),
      breakdown: z.object({
        byProvider: z.array(
          z.object({ provider: str, model: str, charges: Charges, tokens: Tokens }),
        ),
        byWorkKind: z.array(z.object({ workKind: str, activeMs: num })),
        malformedSamples: num,
        omittedSamples: num,
      }),
    }),
  ),
});

const BriefModel = z
  .object({
    requestId: str,
    title: str,
    revision: num,
    changes: num,
    approvalState: str,
    abandoned: bool,
    commentCount: num,
    browserUrl: opt(str),
    approval: z.object({ briefRevision: num, contentDigest: str, agreementDigest: str }),
    lines: z.array(
      z.object({
        id: str,
        number: num,
        text: str,
        kind: str,
        isNew: bool,
        comments: z.array(z.object({ id: str, body: str, author: str })),
      }),
    ),
  })
  .refine((brief) => brief.approval.briefRevision === brief.revision, {
    message: "approval must name the brief's revision",
  });

const Line = num.int().positive();
const PrComment = z.object({
  id: str,
  databaseId: opt(num),
  author: str,
  at: str,
  body: str,
  url: opt(str),
});
const PrThread = z.object({
  id: str,
  file: str,
  line: opt(Line),
  side: z.enum(["LEFT", "RIGHT"]),
  resolved: bool,
  outdated: bool,
  comments: z.array(PrComment),
});
const PrDraft = z.object({ id: str, file: str, line: Line, severity: str, body: str });
const DiffRow = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hunk"), oldStart: num, newStart: num, label: str }),
  z.object({ kind: z.literal("ctx"), text: str, old: Line, new: Line }),
  z.object({ kind: z.literal("add"), text: str, new: Line }),
  z.object({ kind: z.literal("del"), text: str, old: Line }),
]);
const PrModel = z
  .object({
    header: z.object({
      repo: str,
      number: num,
      title: str,
      url: str,
      head: str,
      draft: bool,
      next: str,
      taskId: opt(str),
      commits: num,
      additions: num,
      deletions: num,
      unresolved: num,
      firstThreadId: opt(str),
    }),
    readAt: str,
    tabs: strings,
    checks: z.array(
      z.object({
        name: str,
        state: z.enum(["passed", "running", "failed", "pending"]),
        startedAtMs: opt(num),
        duration: opt(str),
        logUrl: opt(str),
      }),
    ),
    description: z.object({ markdown: str, blocks: strings, conversation: z.array(PrComment) }),
    tour: z.array(
      z.object({
        title: str,
        why: str,
        stops: z.array(
          z
            .object({ file: str, from: Line, to: Line, title: str, body: str, rowIds: strings })
            .refine((stop) => stop.to >= stop.from, {
              message: "a stop must not end before it starts",
            }),
        ),
      }),
    ),
    files: z.array(
      z.object({
        path: str,
        additions: num,
        deletions: num,
        commentCount: num,
        rows: z.array(
          z.object({ id: str, row: DiffRow, threads: z.array(PrThread), drafts: z.array(PrDraft) }),
        ),
      }),
    ),
    unanchoredThreads: z.array(PrThread),
    commentDestination: z.enum(["worker", "review", "read-only"]),
    readOnlyReason: opt(str),
    review: opt(
      z.object({
        taskId: str,
        generation: num,
        head: str,
        currentHead: str,
        posted: bool,
        verdict: opt(str),
        intent: str,
        summary: str,
        drafts: z.array(PrDraft),
        concerns: z.array(z.object({ title: str, detail: str, severity: str })),
        notes: strings,
      }),
    ),
  })
  .refine(
    (pr) =>
      pr.commentDestination !== "review" ||
      (pr.review !== undefined && pr.review !== null && pr.review.head === pr.header.head),
    { message: "a review destination needs the review of the shown head" },
  );

/**
 * The setup block's model: `SetupView` (src/onboarding/setup-view.ts) as written. Each mode has
 * its own detail file, because setup opens beside the conversation and settings in its own tab.
 */
const ModelChoice = z.object({ model: str, thinking: str });
const SetupRepoModel = z.object({
  name: str,
  path: str,
  shownPath: str,
  repo: opt(str),
  setUp: bool,
  validationCommands: strings,
  noChecks: bool,
  setupCommands: strings,
  suggestions: strings,
  detectedFrom: opt(str),
  inspectionError: opt(str),
});
const SetupModel = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(SETUP_MODES),
  generatedAt: str,
  models: z.array(
    z.object({
      selector: str,
      harness: z.enum(["claude-code", "omp"]),
      name: str,
      provider: str,
      thinking: strings,
      context: opt(num),
      cost: opt(z.object({ input: num, output: num })),
      priceLevel: opt(z.enum(["$", "$$", "$$$"])),
    }),
  ),
  harnesses: z.array(
    z.object({
      id: z.enum(["claude-code", "omp"]),
      name: str,
      note: str,
      unavailable: opt(str),
    }),
  ),
  roles: z.array(
    z.object({
      id: str,
      name: str,
      what: str,
      color: str,
      hint: str,
      thinking: str,
      pick: opt(ModelChoice),
      recommended: opt(z.object({ model: ModelChoice, reason: str })),
    }),
  ),
  thinkingLevels: z.array(z.object({ level: str, note: str })),
  repos: z.array(SetupRepoModel),
  candidates: z.array(SetupRepoModel),
  selfImprovement: z.enum(["off", "fix", "report"]),
  section: opt(z.enum(SETUP_SECTIONS)),
});

/** The model schema of each view file kind. The index feeds every screen without a detail file. */
export const VIEW_MODELS = {
  index: IndexModel,
  task: TaskModel,
  brief: BriefModel,
  pr: PrModel,
  setup: SetupModel,
} as const;
export type ViewFileKind = keyof typeof VIEW_MODELS;
export const ViewFileKind = z.enum(["index", "task", "brief", "pr", "setup"]);

export function setupFile(mode: SetupMode): string {
  return `setup-${mode}.json`;
}

/**
 * Every view file. `epoch` names one life of the project's store directory and `seq` orders its
 * writes, so `rt.watch` accepts a file only when it is newer than the model it shows.
 */
export const ViewFile = z
  .object({
    v: z.literal(1),
    kind: ViewFileKind,
    epoch: z.string().min(1),
    seq: z.number().int().positive().safe(),
    model: z.unknown(),
  })
  .strict();
export type ViewFile = z.infer<typeof ViewFile>;
