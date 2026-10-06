import { isAbsolute } from "node:path";
import { z } from "zod";

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
      ]),
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
  BriefFeedback.extend({ verb: z.literal("brief-feedback") }),
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
