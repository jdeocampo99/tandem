import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { nativeViewsPath } from "../board/snapshot.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import { dismissNativeCatchUp } from "../memory/native-visits.ts";
import type { TerminalView } from "../terminal-backend/contract.ts";
import { CliUsageError, text } from "./cli-arguments.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

const summarySchema = z.object({
  project: z.string(),
  changeSignature: z.string().min(1),
  board: z.object({
    lanes: z.array(
      z.object({
        cards: z.array(
          z.object({
            key: z.string(),
            pullRequest: z.object({ url: z.string().url() }).optional(),
          }),
        ),
      }),
    ),
  }),
  catchup: z.object({
    needsYou: z.array(
      z.object({ key: z.string(), taskId: z.string().optional(), cause: z.string() }),
    ),
    merged: z.array(z.object({ number: z.number().int().positive(), url: z.string().url() })),
  }),
});

async function screenOwner(context: NativeRendererContext) {
  const owner = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    {
      home: context.environment.home,
      sessionId: context.environment.sessionId,
      repoPath: context.environment.repo,
    },
  );
  if (owner === undefined || owner.endpoint.terminal !== "tern")
    throw new Error("Open this project's Tern coordinator before using native screens");
  return owner;
}

async function screenSummary(home: string, project: string) {
  const path = nativeViewsPath(home, project);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Native screen data must be a bounded regular file");
  const envelope = z
    .object({
      version: z.literal(1),
      kind: z.literal("panel"),
      revision: z.string().min(1),
      model: summarySchema,
    })
    .parse(JSON.parse(await readFile(path, "utf8")));
  if (envelope.model.project !== project)
    throw new Error("Native screen belongs to another project");
  return envelope.model;
}

async function showScreen(context: NativeRendererContext, view: TerminalView) {
  const owner = await screenOwner(context);
  const result = await context.capabilities.terminal.openView({
    coordinator: owner.endpoint,
    cwd: owner.worktree.path,
    home: context.environment.home,
    origin: context.origin,
    view,
  });
  if (!result.opened) throw new Error(result.warnings.join("; ") || "Tern did not open the view");
  return { value: result };
}

export async function nativeBoard(context: NativeRendererContext) {
  const [action, value, extra] = context.invocation.positionals;
  if (extra !== undefined) throw new CliUsageError("Unexpected board arguments");
  if (action === undefined) return showScreen(context, { kind: "board" });
  if (action === "catchup-dismiss" || action === "catchup-open-needs") {
    if (value !== undefined) throw new CliUsageError("Unexpected catch-up arguments");
    const owner = await screenOwner(context);
    const model = await screenSummary(context.environment.home, owner.repoPath);
    let view: TerminalView = { kind: "orchestrator" };
    if (action === "catchup-open-needs") {
      const needs = model.catchup.needsYou[0];
      if (needs === undefined) return { value: { cancelled: true } };
      if (needs.cause === "brief" && needs.key.startsWith("brief:"))
        view = { kind: "brief", requestId: needs.key.slice(6) };
      else if (needs.taskId !== undefined) view = { kind: "task", taskId: needs.taskId };
      else view = { kind: "inbox" };
    }
    const result = await showScreen(context, { kind: "orchestrator" });
    if (view.kind !== "orchestrator")
      await showScreen(
        {
          ...context,
          origin: { ...context.origin, paneId: owner.endpoint.paneId, cwd: owner.worktree.path },
        },
        view,
      );
    await dismissNativeCatchUp({
      home: context.environment.home,
      project: owner.repoPath,
      now: new Date().toISOString(),
      signature: model.changeSignature,
    });
    return result;
  }
  if (action === "pr-link" || action === "merged-link") {
    const owner = await screenOwner(context);
    const model = await screenSummary(context.environment.home, owner.repoPath);
    const id = text(value, "link identity");
    const url =
      action === "pr-link"
        ? model.board.lanes.flatMap((lane) => lane.cards).find((card) => card.key === id)
            ?.pullRequest?.url
        : model.catchup.merged.find((pr) => pr.url === id)?.url;
    if (url === undefined)
      throw new Error("That PR is no longer in the originating project's view");
    return showScreen(context, { kind: "browser", url });
  }
  throw new CliUsageError("Unknown board action");
}

export async function nativeUsage(context: NativeRendererContext) {
  if (context.invocation.positionals.length !== 0)
    throw new CliUsageError("Unexpected usage arguments");
  return showScreen(context, { kind: "usage" });
}
