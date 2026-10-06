import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const Receipt = z.object({ paneId: Id, tabId: Id, sessionId: Id });
const NativeIntent = z.object({
  version: z.literal(1),
  owner: z.string(),
  route: z.string(),
  ticket: Ticket,
});
const BrowserIntent = z.object({
  version: z.literal(1),
  owner: z.string(),
  browser: z.object({ url: z.string().url(), windowId: z.string().optional() }),
});
const Intent = z.union([NativeIntent, BrowserIntent]);
type TicketModel = z.infer<typeof Ticket>;

async function readPrivateJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error("Invalid native opening evidence file");
  return JSON.parse(await readFile(path, "utf8"));
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    claimBrowser: (browser: z.infer<typeof BrowserIntent>["browser"]) => Promise<void>;
    settle: () => Promise<void>;
  }) => Promise<T>,
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
  let browserPending = false;
  let mutationAttempted = false;
  const settle = async () => {
    // Remove the fence last. Interrupted cleanup still leaves a recoverable intent.
    for (const attempt of pending) {
      await rm(attempt.route, { force: true });
      await rm(attempt.ticket.receipt, { force: true });
    }
    await rm(path, { force: true });
  };
  try {
    try {
      const saved = Intent.parse(await readPrivateJson(path));
      if (saved.owner !== owner) throw new Error("Native opening intent owner changed");
      // A browser listing cannot correlate a URL or PiP owner with an unacknowledged
      // opening. Even a matching title or newly visible browser is insufficient proof.
      if ("browser" in saved) {
        browserPending = true;
        throw new Error("Earlier browser opening has no exact completion evidence");
      }
      pending.push(saved);
    } catch (error) {
      if (!missing(error)) throw new TernOutcomeUnknownError("tern open intent", error);
    }
    // Older hosts retained route tickets without an intent. They fence this owner too.
    for (const name of await readdir(directory)) {
      if (!/^[\da-f-]+\.tandem-open\.json$/u.test(name)) continue;
      const route = join(directory, name);
      if (pending.some((attempt) => attempt.route === route)) continue;
      const ticket = Ticket.parse(await readPrivateJson(route));
      if (
        ticket.coordinator === input.coordinator.paneId &&
        ticket.session === input.coordinator.terminalSessionId &&
        ticket.args[1] === input.coordinator.paneId &&
        ticket.args[2] === input.cwd &&
        ticket.args[4] === input.indexPath
      )
        pending.push({ route, ticket });
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
        let replaced = attempt.ticket.replaced;
        if (replaced === undefined && attempt.ticket.placement === "task") {
          // Older durable intents omitted replacement metadata, but their retained
          // layout routes included it. Missing/conflicting routes cannot prove retirement.
          const retained = Ticket.parse(await readPrivateJson(attempt.route));
          if (
            JSON.stringify({ ...retained, replaced: undefined }) !==
            JSON.stringify({ ...attempt.ticket, replaced: undefined })
          )
            throw new Error("Retained task route conflicts with its opening intent");
          replaced = retained.replaced;
        }
        await proveTaskReplacement(commands, input.cwd, replaced);
        try {
          const receipt = Receipt.parse(await readPrivateJson(attempt.ticket.receipt));
          if (
            receipt.paneId !== exact.block.id ||
            receipt.tabId !== exact.tab.id ||
            receipt.sessionId !== exact.session.id
          )
            throw new Error("Retained receipt conflicts with exact native block evidence");
        } catch (error) {
          if (!missing(error)) throw error;
        }
      } catch (cause) {
        throw new TernOutcomeUnknownError("tern open recovery", cause);
      }
    }
    const recovered = pending.length > 0;
    if (recovered) await settle();
    pending.length = 0;
    return await operation({
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
      claimBrowser: async (browser) => {
        await writeFile(path, JSON.stringify({ version: 1, owner, browser }), {
          flag: "wx",
          mode: 0o600,
        });
        browserPending = true;
        claimedThisCall = true;
      },
      settle,
    });
  } catch (cause) {
    // Only this invocation can prove that its opening was never attempted.
    // Earlier retained attempts remain uncertain, even if recovery's reads fail.
    if (claimedThisCall && !mutationAttempted) {
      await settle();
      throw cause;
    }
    if ((pending.length > 0 || browserPending) && !(cause instanceof TernOutcomeUnknownError))
      throw new TernOutcomeUnknownError("tern open verification", cause);
    throw cause;
  } finally {
    await release();
  }
}
