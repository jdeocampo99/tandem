import { createHash } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Endpoint } from "../../contracts.ts";
import { ensurePrivateDirectoryTree } from "../../coordinator/lock.ts";
import { acquireDarwinFileLock } from "../../tasks/store-lock.ts";
import {
  blocks,
  Id,
  type TernCommands,
  TernOutcomeUnknownError,
  ternCommands,
} from "./protocol.ts";

export const NativePlacement = z.enum(["panel", "split", "task", "window", "return", "inbox"]);
const Ticket = z.object({
  version: z.literal(1),
  kind: z.enum([
    "panel",
    "task",
    "task-picker",
    "brief",
    "pr",
    "prs",
    "board",
    "usage",
    "catchup",
    "welcome",
  ]),
  placement: NativePlacement,
  args: z.array(z.string()).length(5),
  coordinator: Id,
  session: Id,
  receipt: z.string(),
  replaced: Id.optional(),
});
/** The host writes exactly one receipt per ticket, on success and on every failure. */
export const Receipt = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), paneId: Id, tabId: Id, sessionId: Id }),
  z.object({
    status: z.literal("failed"),
    stage: z.string(),
    appliedEffects: z.number().int().nonnegative(),
    reason: z.string(),
  }),
]);
export type Receipt = z.infer<typeof Receipt>;
const Intent = z.object({
  version: z.literal(1),
  owner: z.string(),
  route: z.string(),
  ticket: Ticket,
});
type TicketModel = z.infer<typeof Ticket>;

/** The host failed before any layout effect, so the open settled and the user can retry it. */
export class NativeViewNotOpenedError extends Error {
  constructor() {
    super("The Tandem view did not open and nothing changed. Open it again.");
    this.name = "NativeViewNotOpenedError";
  }
}

/** Tern applied layout effects before failing, so their outcome must stay quarantined. */
export function partialOpenFailure(receipt: Extract<Receipt, { status: "failed" }>): Error {
  return new TernOutcomeUnknownError(
    "tern open",
    `host failed at ${receipt.stage} after ${receipt.appliedEffects} layout effects: ${receipt.reason}`,
  );
}

async function readPrivateJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error("Invalid native opening evidence file");
  return JSON.parse(await readFile(path, "utf8"));
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
/**
 * Tern's fs has no rename, so a receipt may be read mid-write. Only a whole receipt parses;
 * anything else throws and the caller keeps waiting or keeps the intent.
 */
export async function readReceipt(path: string): Promise<Receipt | undefined> {
  try {
    return Receipt.parse(await readPrivateJson(path));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** The new task's identity cannot prove that retiring its predecessor succeeded. */
export async function proveTaskReplacement(
  commands: TernCommands,
  cwd: string,
  replaced: string | undefined,
): Promise<void> {
  if (replaced === undefined) return;
  try {
    const listing = await commands.ls(cwd);
    if (listing.detached.length > 0 || blocks(listing).some((entry) => entry.block.id === replaced))
      throw new Error("replaced task is still present or its absence is ambiguous");
  } catch (cause) {
    throw new TernOutcomeUnknownError("tern task replacement", cause);
  }
}

/** Match all launch arguments in the exact session and intended tab placement, never a title. */
export async function exactNativeView(
  commands: TernCommands,
  cwd: string,
  coordinator: Endpoint,
  kind: string,
  placement: z.infer<typeof NativePlacement>,
  args: readonly string[],
) {
  if (placement === "return" || placement === "inbox") return undefined;
  const listing = await commands.ls(cwd);
  const request = commands.request(cwd, []);
  // A window-scoped listing cannot prove that no matching block exists elsewhere.
  const all = request.argv.includes("--window")
    ? await ternCommands(commands.run, {
        binary: commands.binary,
        ...(request.env === undefined ? {} : { environment: request.env }),
      }).ls(cwd)
    : listing;
  const claims = blocks(all).filter(
    (entry) =>
      entry.block.program === `tandem.${kind}` &&
      entry.block.args?.length === args.length &&
      entry.block.args.every((arg, index) => index === 3 || arg === args[index]),
  );
  const exact = claims[0];
  if (
    listing.detached.length > 0 ||
    all.detached.length > 0 ||
    claims.length > 1 ||
    (exact !== undefined &&
      (exact.session.id !== coordinator.terminalSessionId ||
        (placement === "window"
          ? exact.tab.id === coordinator.tabId
          : exact.tab.id !== coordinator.tabId) ||
        JSON.stringify(exact.block.args) !== JSON.stringify(args) ||
        !blocks(listing).some(
          (entry) =>
            entry.block.id === exact.block.id &&
            entry.session.id === exact.session.id &&
            entry.tab.id === exact.tab.id &&
            entry.block.program === exact.block.program &&
            JSON.stringify(entry.block.args) === JSON.stringify(args),
        ))) ||
    (exact === undefined &&
      blocks(listing).some(
        (entry) =>
          entry.block.program === `tandem.${kind}` &&
          JSON.stringify(entry.block.args) === JSON.stringify(args),
      ))
  )
    throw new TernOutcomeUnknownError(
      "tern open",
      "native view placement or identity is ambiguous, detached or outside the owning window",
    );
  return exact;
}

/** A durable coordinator-bound fence serializes openings across CLI calls and relaunches. */
export async function withNativeOpenIntent<T>(
  input: { home: string; coordinator: Endpoint; cwd: string; indexPath: string },
  commands: TernCommands,
  operation: (intent: {
    recovered: boolean;
    markMutationAttempted: () => void;
    claim: (route: string, ticket: TicketModel) => Promise<void>;
    settle: () => Promise<void>;
  }) => Promise<T>,
  onUnresolved?: (cause: TernOutcomeUnknownError) => Promise<T>,
  runOperation?: (operation: () => Promise<T>, recovered: boolean) => Promise<T>,
): Promise<T> {
  const directory = join(input.home, "native-host");
  await ensurePrivateDirectoryTree(directory, "native route directory");
  const owner = JSON.stringify([
    input.coordinator.terminal,
    input.coordinator.sessionId,
    input.coordinator.terminalSessionId,
    input.coordinator.tabId,
    input.coordinator.workspaceId,
    input.coordinator.paneId,
    input.coordinator.generation,
    input.cwd,
    input.indexPath,
  ]);
  const key = createHash("sha256").update(owner).digest("hex");
  const path = join(directory, `${key}.intent.json`);
  const release = await acquireDarwinFileLock(join(directory, `${key}.lock`), 10000, 20);
  const pending: { route: string; ticket: TicketModel }[] = [];
  let claimedThisCall = false;
  let mutationAttempted = false;
  let recovering = true;
  const settle = async () => {
    // Remove the fence last. Interrupted cleanup still leaves a recoverable intent.
    for (const attempt of pending) {
      await rm(attempt.route, { force: true });
      await rm(attempt.ticket.receipt, { force: true });
    }
    await rm(path, { force: true });
    pending.length = 0;
  };
  try {
    try {
      const saved = Intent.parse(await readPrivateJson(path));
      if (saved.owner !== owner) throw new Error("Native opening intent owner changed");
      pending.push(saved);
    } catch (error) {
      if (!missing(error)) throw new TernOutcomeUnknownError("tern open intent", error);
    }
    for (const attempt of pending) {
      try {
        if (
          !/^[\da-f-]+\.tandem-open\.json$/u.test(attempt.route.slice(directory.length + 1)) ||
          attempt.route !== join(directory, attempt.route.slice(directory.length + 1)) ||
          attempt.ticket.receipt !==
            attempt.route.replace(/\.tandem-open\.json$/u, ".receipt.json") ||
          attempt.ticket.coordinator !== input.coordinator.paneId ||
          attempt.ticket.session !== input.coordinator.terminalSessionId ||
          attempt.ticket.args[1] !== input.coordinator.paneId ||
          attempt.ticket.args[2] !== input.cwd ||
          attempt.ticket.args[4] !== input.indexPath
        )
          throw new Error("Native opening evidence owner or paths changed");
        const receipt = await readReceipt(attempt.ticket.receipt);
        if (receipt?.status === "failed") {
          if (receipt.appliedEffects > 0) throw partialOpenFailure(receipt);
          continue;
        }
        const exact = await exactNativeView(
          commands,
          input.cwd,
          input.coordinator,
          attempt.ticket.kind,
          attempt.ticket.placement,
          attempt.ticket.args,
        );
        if (exact === undefined)
          throw new Error("Earlier opening has no exact native block evidence");
        await proveTaskReplacement(commands, input.cwd, attempt.ticket.replaced);
        if (
          receipt !== undefined &&
          (receipt.paneId !== exact.block.id ||
            receipt.tabId !== exact.tab.id ||
            receipt.sessionId !== exact.session.id)
        )
          throw new Error("Retained receipt conflicts with exact native block evidence");
      } catch (cause) {
        throw new TernOutcomeUnknownError("tern open recovery", cause);
      }
    }
    const recovered = pending.length > 0;
    if (recovered) await settle();
    recovering = false;
    const invoke = () =>
      operation({
        recovered,
        markMutationAttempted: () => {
          mutationAttempted = true;
        },
        claim: async (route, ticket) => {
          await writeFile(path, JSON.stringify({ version: 1, owner, route, ticket }), {
            flag: "wx",
            mode: 0o600,
          });
          pending.push({ route, ticket });
          claimedThisCall = true;
        },
        settle,
      });
    return await (runOperation === undefined ? invoke() : runOperation(invoke, recovered));
  } catch (cause) {
    // Only this invocation can prove that its opening was never attempted.
    // Earlier retained attempts remain uncertain, even if recovery's reads fail.
    if (claimedThisCall && !mutationAttempted) {
      await settle();
      throw cause;
    }
    if (pending.length > 0 && !(cause instanceof TernOutcomeUnknownError))
      throw new TernOutcomeUnknownError("tern open verification", cause);
    if (recovering && cause instanceof TernOutcomeUnknownError && onUnresolved !== undefined)
      return await onUnresolved(cause);
    throw cause;
  } finally {
    await release();
  }
}
