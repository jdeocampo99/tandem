import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { setupFile } from "./view-file.ts";

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

export const PaneId = z.string().regex(/^[1-9]\d*$/u);
export const AbsolutePath = z
  .string()
  .refine((path) => isAbsolute(path), "must be an absolute path");

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
    /** The task block this open retires; it must be gone once the open settles. */
    replaced: PaneId.optional(),
    /** The task block a return from the task picker focuses again and keeps. */
    returnTo: PaneId.optional(),
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
