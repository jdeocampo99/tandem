import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { SETUP_MODES, SETUP_SECTIONS, type SetupMode } from "../onboarding/setup-view.ts";
import { QUICK_SCOPE_CHOICES, type QuickScopeChoice } from "../tasks/quick.ts";

/** Every native block Tandem defines, as `tandem.<kind>` programs. */
export const VIEW_KINDS = [
  "panel",
  "welcome",
  "task",
  "task-picker",
  "brief",
  "pr",
  "prs",
  "board",
  "usage",
  "catchup",
  "setup",
  "quick-task",
] as const;
export const ViewKind = z.enum(VIEW_KINDS);
export type ViewKind = z.infer<typeof ViewKind>;

export const Placement = z.enum(["panel", "split", "task", "window", "return", "inbox"]);
export type Placement = z.infer<typeof Placement>;

const PaneId = z.string().regex(/^[1-9]\d*$/u);
const AbsolutePath = z.string().refine((path) => isAbsolute(path), "must be an absolute path");

/**
 * Who a block belongs to. Luau never reads it: blocks echo it back verbatim with every action,
 * and TypeScript alone matches listings against it.
 */
export const BlockContext = z
  .object({
    coordinator: PaneId,
    cwd: AbsolutePath,
    home: AbsolutePath,
    index: AbsolutePath,
    window: z.string().min(1).optional(),
  })
  .strict();
export type BlockContext = z.infer<typeof BlockContext>;

function serialize(ctx: BlockContext): string {
  return JSON.stringify({
    coordinator: ctx.coordinator,
    cwd: ctx.cwd,
    home: ctx.home,
    index: ctx.index,
    ...(ctx.window === undefined ? {} : { window: ctx.window }),
  });
}

/**
 * The only constructor of a native block's launch arguments: the view it draws, its opaque
 * context, and the project index it also watches (the context's `index`, readable by Luau).
 */
export function blockArgs(viewPath: string, ctx: BlockContext): [string, string, string] {
  const parsed = BlockContext.parse(ctx);
  return [viewPath, serialize(parsed), parsed.index];
}

/** Parses an echoed context; throws when it is not exactly what `blockArgs` writes. */
export function parseBlockContext(text: string): BlockContext {
  const ctx = BlockContext.parse(JSON.parse(text));
  if (serialize(ctx) !== text) throw new Error("Native block context is not canonical");
  return ctx;
}

/** The only reader of listed launch arguments; anything `blockArgs` did not write is undefined. */
export function parseBlockArgs(
  args: readonly string[] | undefined,
): Readonly<{ viewPath: string; ctx: BlockContext }> | undefined {
  const [viewPath, ctx, index] = args ?? [];
  if (args?.length !== 3 || viewPath === undefined || ctx === undefined) return undefined;
  try {
    const parsed = parseBlockContext(ctx);
    return parsed.index === index ? { viewPath, ctx: parsed } : undefined;
  } catch {
    return undefined;
  }
}

/** The coordinator a ticket's owner records, so `tandem fix` can prove it present or gone. */
const TicketOwner = z
  .object({
    sessionId: z.string(),
    workspaceId: PaneId,
    tabId: PaneId,
    generation: z.number().int(),
  })
  .strict();

/**
 * One staged open, written by TypeScript and interpreted by `layout.luau`. A ticket without
 * `expiresAt` is only claimed: nothing has been dispatched, so it can be dropped.
 */
export const Ticket = z
  .object({
    version: z.literal(1),
    kind: ViewKind,
    placement: Placement,
    args: z.tuple([z.string(), z.string(), z.string()]),
    coordinator: PaneId,
    origin: PaneId,
    session: PaneId,
    owner: TicketOwner,
    receipt: AbsolutePath,
    replaced: PaneId.optional(),
    closeOrigin: PaneId.optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();
export type Ticket = z.infer<typeof Ticket>;

/** `layout.luau` writes exactly one receipt per ticket, on success and on every failure. */
export const Receipt = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), paneId: PaneId, tabId: PaneId, sessionId: PaneId }),
  z.object({
    status: z.literal("failed"),
    stage: z.string(),
    appliedEffects: z.number().int().nonnegative(),
    reason: z.string(),
  }),
]);
export type Receipt = z.infer<typeof Receipt>;

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
  badge: opt(z.literal("QUICK")),
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
  badge: opt(z.literal("QUICK")),
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
  scope: opt(z.object({ label: str, text: str, note: opt(str) })),
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

/**
 * The quick task composer's model: `QuickTaskView` (src/tasks/quick.ts), the project the click
 * is proved against and the validation the block mirrors so Start is disabled for too-short text.
 */
const QuickTaskModel = z.object({
  schemaVersion: z.literal(1),
  repo: str,
  branch: str,
  placeholder: str,
  minChars: num.int().positive(),
  minWords: num.int().positive(),
  tooShort: str,
});

/** The model schema of each view file kind. The index feeds every screen without a detail file. */
export const VIEW_MODELS = {
  index: IndexModel,
  task: TaskModel,
  brief: BriefModel,
  pr: PrModel,
  setup: SetupModel,
  "quick-task": QuickTaskModel,
} as const;
export type ViewFileKind = keyof typeof VIEW_MODELS;
export const ViewFileKind = z.enum(["index", "task", "brief", "pr", "setup", "quick-task"]);

/** The composer's one detail file; like every detail file it starts with its block kind. */
export const QUICK_TASK_FILE = "quick-task-composer.json";

export function setupFile(mode: SetupMode): string {
  return `setup-${mode}.json`;
}

const WINDOW_KINDS: readonly ViewKind[] = ["board", "usage", "catchup"];

/**
 * Whether a view opens as its own full-window tab. Board, usage and catch-up always do; setup does
 * only as settings, which its detail file tells: setup opens beside the conversation.
 */
export function isWindowView(kind: ViewKind, viewPath: string): boolean {
  return (
    WINDOW_KINDS.includes(kind) ||
    (kind === "setup" && basename(viewPath) === setupFile("settings"))
  );
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

/**
 * The only spelling of a scope-question answer link, `tandem://answer/TASK/QUESTION/CHOICE`.
 * `window.luau` turns it into a `quick-answer` action from the focused pane.
 */
export function nativeAnswerLink(
  taskId: string,
  questionId: string,
  choice: QuickScopeChoice,
): string {
  if (!/^[\w-]+$/u.test(taskId) || !/^[\w-]+$/u.test(questionId))
    throw new Error(`Not a native answer link: ${taskId}/${questionId}`);
  return `tandem://answer/${taskId}/${questionId}/${choice}`;
}

/** Reply links a coordinator prints and `host.luau`'s `route.link` turns into an `open` action. */
export const LINK_KINDS = ["task", "brief", "pr"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** The only spelling of a `tandem://` link; ids are durable task, request or PR numbers. */
export function nativeLink(kind: LinkKind, id: string): string {
  if (!/^[\w-]+$/u.test(id) || (kind === "pr" && !/^\d+$/u.test(id)))
    throw new Error(`Not a native ${kind} link id: ${id}`);
  return `tandem://${kind}/${id}`;
}

const Id = z.string().regex(/^[\w-]+$/u, "must contain only letters, digits, _ and -");
const Text = z
  .string()
  .refine((value) => value.trim().length > 0, "must be non-empty text")
  .refine((value) => !value.includes("\0"), "must not contain NUL characters")
  .transform((value) => value.trim());
const Count = z.number().int().positive().safe();

/**
 * Where a click came from. A block echoes the context it was launched with; a window command
 * names the focused pane's absolute cwd and, when Tern exports it, the window key.
 */
export const ActionOrigin = z.union([
  z.object({ pane: PaneId, ctx: z.string() }).strict(),
  z.object({ pane: PaneId, cwd: AbsolutePath, window: z.string().min(1).optional() }).strict(),
]);
export type ActionOrigin = z.infer<typeof ActionOrigin>;

/** What an `open` action shows. PRs open by number, qualified by repository when known. */
export const ViewRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: Id }).strict(),
  z.object({ kind: z.literal("brief"), requestId: Id }).strict(),
  z.object({ kind: z.literal("pr"), number: Count, repo: z.string().min(1).optional() }).strict(),
  z
    .object({
      kind: z.enum([
        "board",
        "usage",
        "prs",
        "orchestrator",
        "inbox",
        "task-picker",
        "new-request",
        "quick-task",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("setup"),
      mode: z.enum(SETUP_MODES),
      section: z.enum(SETUP_SECTIONS).optional(),
    })
    .strict(),
]);
export type ViewRef = z.infer<typeof ViewRef>;

const ViewedBrief = {
  requestId: Id,
  briefRevision: Count,
  contentDigest: Text,
  agreementDigest: Text,
};
const BriefFeedback = z
  .object({
    ...ViewedBrief,
    text: Text.optional(),
    comments: z
      .array(z.object({ lineId: z.string().min(1), text: Text }).strict())
      .max(100, "Brief feedback may have at most 100 comments"),
  })
  .strict();

/** Every click a native view or window command can make, discriminated on `verb`. */
export const Action = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("open"), ref: ViewRef }).strict(),
  z.object({ verb: z.literal("open-project") }).strict(),
  z
    .object({
      verb: z.literal("project"),
      target: z.union([
        z.number().int().min(1).max(9),
        z.enum(["prev", "next"]),
        z.object({ repoPath: AbsolutePath }).strict(),
      ]),
    })
    .strict(),
  /** The window's focus lifecycle: entering a pane, leaving it, and the visible heartbeat. */
  z.object({ verb: z.literal("visit"), event: z.enum(["entry", "away", "visible"]) }).strict(),
  z.object({ verb: z.literal("restart"), taskId: Id }).strict(),
  z.object({ verb: z.literal("steer"), taskId: Id, text: Text }).strict(),
  z.object({ verb: z.literal("brief-approve"), ...ViewedBrief }).strict(),
  BriefFeedback.extend({ verb: z.literal("brief-request-changes") }),
  z
    .object({
      verb: z.literal("pr-comment"),
      taskId: Id,
      text: Text.optional(),
      comments: z.array(z.object({ file: Text, line: Count, text: Text }).strict()).optional(),
      replies: z.array(z.unknown()).optional(),
      reviewHead: Text.optional(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("review-submit"),
      taskId: Id,
      reviewHead: z
        .string()
        .min(1)
        .refine((head) => head.trim() === head, "must be copied from the displayed review"),
      reviewGeneration: z.number().int().nonnegative().safe(),
      /** The review page's `ReviewSubmission`, validated by its own parser. */
      submission: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ verb: z.literal("catchup-dismiss") }).strict(),
  z.object({ verb: z.literal("catchup-open-needs") }).strict(),
  z.object({ verb: z.literal("board-link"), cardKey: z.string().min(1) }).strict(),
  z.object({ verb: z.literal("merged-link"), url: z.string().url() }).strict(),
  /** The setup block's answer: parsed by `parseSetupAnswer`, so its shape lives in one place. */
  z.object({ verb: z.literal("setup-save"), answer: z.record(z.string(), z.unknown()) }).strict(),
  /**
   * The quick task composer's Start: the user's text, verbatim. The click is their approval of it
   * as the scope; `checkQuickText` (src/tasks/quick.ts) validates it, never a model.
   */
  z.object({ verb: z.literal("quick-start"), text: z.string().max(16_000) }).strict(),
  /** The user's answer to a quick task's scope question, clicked from its chat link. */
  z
    .object({
      verb: z.literal("quick-answer"),
      taskId: Id,
      questionId: Id,
      choice: z.enum(QUICK_SCOPE_CHOICES),
    })
    .strict(),
]);
export type Action = z.infer<typeof Action>;

/** The one input of `tandem native act`, written by `rt.act` to its stdin. */
export const ActionEnvelope = z
  .object({ v: z.literal(1), origin: ActionOrigin, action: Action })
  .strict();
export type ActionEnvelope = z.infer<typeof ActionEnvelope>;

/**
 * What `rt.act` shows for an outcome. Each code has one toast title and level in `rt.luau`;
 * `failed` takes the title of the screen that asked.
 */
export const NOTICE_CODES = [
  "failed",
  "view-kept",
  "catch-up-unavailable",
  "brief-warning",
  "brief-left-open",
  "review-posted",
  "review-unconfirmed",
  "feedback-saved",
  "setup-incomplete",
  "quick-warning",
] as const;
export const NoticeCode = z.enum(NOTICE_CODES);
export type NoticeCode = z.infer<typeof NoticeCode>;

/**
 * `done`: the click did what it asked. `kept`: part of it did not happen, typically a view that
 * could not be closed or proved, and the originating view stays. `refused`: Tandem refused the
 * click or it failed; the notice says why, and the user may try again.
 */
export const Outcome = z
  .object({
    status: z.enum(["done", "kept", "refused"]),
    notice: z
      .object({ code: NoticeCode, text: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type Outcome = z.infer<typeof Outcome>;
