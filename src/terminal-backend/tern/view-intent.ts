import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Endpoint } from "../../contracts.ts";
import { ensurePrivateDirectoryTree } from "../../coordinator/lock.ts";
import { acquireDarwinFileLock } from "../../tasks/store-lock.ts";
import { blocks, Id, type TernCommands, TernOutcomeUnknownError } from "./protocol.ts";

export const NativePlacement = z.enum(["panel", "split", "task", "window", "return", "inbox"]);
const Ticket = z.object({
  version: z.literal(1),
  kind: z.enum(["panel", "task", "brief", "pr", "prs", "board", "usage", "catchup", "welcome"]),
  placement: NativePlacement,
  args: z.array(z.string()).length(5),
  coordinator: Id,
  session: Id,
  receipt: z.string(),
});
const Receipt = z.object({ paneId: Id, tabId: Id, sessionId: Id });
const Intent = z.object({
  version: z.literal(1),
  owner: z.string(),
  route: z.string(),
  ticket: Ticket,
});
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
  const candidates = blocks(listing).filter(
    (entry) =>
      entry.session.id === coordinator.terminalSessionId &&
      entry.block.program === `tandem.${kind}` &&
      JSON.stringify(entry.block.args) === JSON.stringify(args),
  );
  if (
    candidates.length > 1 ||
    (candidates.length > 0 && listing.detached.length > 0) ||
    candidates.some((entry) =>
      placement === "window"
        ? entry.tab.id === coordinator.tabId
        : entry.tab.id !== coordinator.tabId,
    )
  )
    throw new TernOutcomeUnknownError(
      "tern open",
      "native view placement or identity is ambiguous",
    );
  return candidates[0];
}

/** A durable coordinator-bound fence serializes openings across CLI calls and relaunches. */
export async function withNativeOpenIntent<T>(
  input: { home: string; coordinator: Endpoint; cwd: string; indexPath: string },
  commands: TernCommands,
  operation: (intent: {
    recovered: boolean;
    claim: (route: string, ticket: TicketModel) => Promise<void>;
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
      claim: async (route, ticket) => {
        await writeFile(path, JSON.stringify({ version: 1, owner, route, ticket }), {
          flag: "wx",
          mode: 0o600,
        });
        pending.push({ route, ticket });
      },
      settle,
    });
  } catch (cause) {
    if (pending.length > 0 && !(cause instanceof TernOutcomeUnknownError))
      throw new TernOutcomeUnknownError("tern open verification", cause);
    throw cause;
  } finally {
    await release();
  }
}
