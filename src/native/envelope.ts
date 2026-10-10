import { z } from "zod";
import { SETUP_MODES, SETUP_SECTIONS } from "../onboarding/setup-view.ts";
import { AbsolutePath, PaneId } from "./block.ts";

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
/** `owner/name`, spliced into `owner/name#N`, so no `#` or `/` beyond the one separator. */
const GitHubRepository = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u, "must be owner/name");

/** The manifest id of the PR Guide Tern plugin, the only plugin `pr-fix` accepts. */
export const PR_GUIDE_PLUGIN = "prguide";

/**
 * Where a click came from. A block echoes the context it was launched with; a window command
 * names the focused pane's absolute cwd and, when Tern exports it, the window key.
 */
export const ActionOrigin = z.union([
  z.object({ pane: PaneId, ctx: z.string() }).strict(),
  z.object({ pane: PaneId, cwd: AbsolutePath, window: z.string().min(1).optional() }).strict(),
]);
export type ActionOrigin = z.infer<typeof ActionOrigin>;

/**
 * Where a plugin's own window click came from: the plugin's manifest id and the one Tandem project
 * it acts on. It names no pane, so it is a separate origin that no pane consumer has to handle.
 */
export const PluginOrigin = z
  .object({ plugin: z.string().min(1), repoPath: AbsolutePath })
  .strict();
export type PluginOrigin = z.infer<typeof PluginOrigin>;

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
  /** The PR Guide plugin handing a watched pull request to Tandem's `pr-watch-fix` pipeline. */
  z
    .object({ verb: z.literal("pr-fix"), repo: GitHubRepository, number: Count, reason: Text })
    .strict(),
]);
export type Action = z.infer<typeof Action>;

/** The one input of `tandem native act`, written by `rt.act` to its stdin. */
export const ActionEnvelope = z
  .object({ v: z.literal(1), origin: ActionOrigin, action: Action })
  .strict();
export type ActionEnvelope = z.infer<typeof ActionEnvelope>;

/** The same envelope sent by a plugin's own window; `ActionEnvelope` stays pane-origin only. */
export const PluginEnvelope = z
  .object({ v: z.literal(1), origin: PluginOrigin, action: Action })
  .strict();
export type PluginEnvelope = z.infer<typeof PluginEnvelope>;

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
  "origin-unproven",
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
