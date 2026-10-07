import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EndpointOwnershipError } from "../../adapters/primitives.ts";
import type { Endpoint } from "../../contracts.ts";
import { ensurePrivateDirectoryTree } from "../../coordinator/lock.ts";
import {
  type BlockContext,
  blockArgs,
  isWindowView,
  type Placement,
  parseBlockArgs,
  Receipt,
  setupFile,
  Ticket,
  ViewKind,
} from "../../native/contract.ts";
import {
  openDirectories,
  openDirectory,
  viewDetailPath,
  viewIndexPath,
} from "../../native/store.ts";
import { StoreLockTimeoutError } from "../../tasks/store-errors.ts";
import { acquireDarwinFileLock } from "../../tasks/store-lock.ts";
import type { RetainedViewOpen, ViewOrigin, ViewsCapability } from "../contract.ts";
import { ternEndpoint } from "../identity.ts";
import type { TernCli, ViewTarget } from "./cli.ts";
import {
  blocks,
  Id,
  type LocatedBlock,
  type TernListing,
  TernOutcomeUnknownError,
} from "./protocol.ts";

/** How long `layout.luau` may start stages of a dispatched ticket. The click waits 5 s of it. */
const TICKET_LIFETIME_MS = 10_000;
const TICKET = ".ticket.json";
const RECEIPT = ".receipt.json";
const reusableRoots: readonly ViewKind[] = ["board", "usage", "catchup", "prs", "setup"];

/** The host failed before any layout effect, so the open settled and the user can retry it. */
export class NativeViewNotOpenedError extends Error {
  constructor() {
    super("The Tandem view did not open and nothing changed. Open it again.");
    this.name = "NativeViewNotOpenedError";
  }
}

/** The view opened and was gone before Tandem could confirm it, so the open settled. */
export class NativeViewClosedError extends Error {
  constructor() {
    super("The Tandem view closed before Tandem confirmed it. Open it again.");
    this.name = "NativeViewClosedError";
  }
}

/** The window-scoped listing a ticket opened in, and every window's, to rule out duplicates. */
export type ViewListing = Readonly<{ window: TernListing; all: TernListing }>;

/** What `decide` concludes about one ticket; see the staged open state machine. */
export type Decision =
  | Readonly<{ action: "drop" }>
  | Readonly<{ action: "wait" }>
  | Readonly<{ action: "settle"; outcome: "opened"; block: LocatedBlock }>
  | Readonly<{ action: "settle"; outcome: "closed" }>
  | Readonly<{ action: "settle"; outcome: "not-opened" }>
  | Readonly<{ action: "quarantine"; reason: string }>;

type ViewIdentity = Readonly<{
  kind: ViewKind;
  placement: Placement;
  args: readonly [string, string, string];
  session: string;
  tab: string;
}>;

function sameView(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A listed block launched for the same view and owner, whichever window key it was given. */
function claimsView(entry: LocatedBlock, view: ViewIdentity): boolean {
  const listed = parseBlockArgs(entry.block.args);
  const wanted = parseBlockArgs(view.args);
  if (entry.block.program !== `tandem.${view.kind}` || listed === undefined || wanted === undefined)
    return false;
  const { window: _listedWindow, ...listedOwner } = listed.ctx;
  const { window: _wantedWindow, ...wantedOwner } = wanted.ctx;
  return (
    listed.viewPath === wanted.viewPath &&
    JSON.stringify(listedOwner) === JSON.stringify(wantedOwner)
  );
}

/** The one exact block for a view, or an ambiguity that no later read can resolve safely. */
function matchView(
  listing: ViewListing,
  view: ViewIdentity,
): Readonly<{ exact: LocatedBlock | undefined; ambiguous: boolean }> {
  const claims = blocks(listing.all).filter((entry) => claimsView(entry, view));
  const exact = claims[0];
  const inWindow = blocks(listing.window);
  const ambiguous =
    listing.window.detached.length > 0 ||
    listing.all.detached.length > 0 ||
    claims.length > 1 ||
    (exact !== undefined &&
      (exact.session.id !== view.session ||
        (view.placement === "window" ? exact.tab.id === view.tab : exact.tab.id !== view.tab) ||
        !sameView(exact.block.args, view.args) ||
        !inWindow.some(
          (entry) =>
            entry.block.id === exact.block.id &&
            entry.session.id === exact.session.id &&
            entry.tab.id === exact.tab.id &&
            entry.block.program === exact.block.program &&
            sameView(entry.block.args, view.args),
        ))) ||
    (exact === undefined &&
      inWindow.some(
        (entry) =>
          entry.block.program === `tandem.${view.kind}` && sameView(entry.block.args, view.args),
      ));
  return { exact, ambiguous };
}

function identity(ticket: Ticket): ViewIdentity {
  return {
    kind: ticket.kind,
    placement: ticket.placement,
    args: ticket.args,
    session: ticket.session,
    tab: ticket.owner.tabId,
  };
}

function failureReason(receipt: Extract<Receipt, { status: "failed" }>): string {
  return `Tern failed at ${receipt.stage} after ${receipt.appliedEffects} layout changes: ${receipt.reason}`;
}

/**
 * The staged open state machine. Nothing here retries: a settled ticket is gone and a new click
 * is a new ticket; a quarantined one stays until evidence or `tandem fix` settles it.
 */
export function decide(
  ticket: Ticket,
  receipt: ObservedReceipt,
  listing: ViewListing | undefined,
  now: number,
): Decision {
  if (receipt === undefined || receipt === "torn") {
    if (ticket.expiresAt === undefined) return { action: "drop" };
    if (now < ticket.expiresAt) return { action: "wait" };
    return {
      action: "quarantine",
      reason:
        receipt === undefined
          ? "Tern never confirmed the view opened"
          : "the view's receipt cannot be read",
    };
  }
  if (receipt.status === "failed")
    return receipt.appliedEffects === 0
      ? { action: "settle", outcome: "not-opened" }
      : { action: "quarantine", reason: failureReason(receipt) };
  if (listing === undefined)
    return { action: "quarantine", reason: "Tern's block listing could not be read" };
  const inWindow = blocks(listing.window);
  const present = (id: string | undefined) =>
    id !== undefined && inWindow.some((entry) => entry.block.id === id);
  if (listing.window.detached.length > 0 || present(ticket.replaced) || present(ticket.closeOrigin))
    return {
      action: "quarantine",
      reason: "a pane the view replaced is still present or its absence is ambiguous",
    };
  const unproved = {
    action: "quarantine",
    reason: "Tern reported the view opened, but the exact view could not be proved",
  } as const;
  const confirms = (entry: LocatedBlock) =>
    entry.block.id === receipt.paneId &&
    entry.tab.id === receipt.tabId &&
    entry.session.id === receipt.sessionId &&
    receipt.sessionId === ticket.session;
  if (ticket.placement === "return" || ticket.placement === "inbox") {
    const expected = ticket.placement === "return" ? ticket.coordinator : ticket.origin;
    if (receipt.paneId !== expected) return unproved;
    const entry = inWindow.find((each) => each.block.id === expected);
    if (entry === undefined) return { action: "settle", outcome: "closed" };
    return confirms(entry) ? { action: "settle", outcome: "opened", block: entry } : unproved;
  }
  const { exact, ambiguous } = matchView(listing, identity(ticket));
  if (ambiguous) return unproved;
  // The receipt's pane still exists but is not this view: something else holds it.
  if (exact === undefined)
    return present(receipt.paneId) ? unproved : { action: "settle", outcome: "closed" };
  return confirms(exact) ? { action: "settle", outcome: "opened", block: exact } : unproved;
}

/**
 * Both listings, read through the call's window scope when it has one. A return or inbox opens
 * nothing new, so only its own window matters.
 */
async function listViews(cmd: TernCli, cwd: string, placement?: Placement): Promise<ViewListing> {
  const window = await cmd.ls(cwd);
  // A window-scoped listing cannot prove that no matching block exists elsewhere.
  const all =
    placement !== "return" && placement !== "inbox" && cmd.windowed
      ? await cmd.unscoped().ls(cwd)
      : window;
  return { window, all };
}

/** The exact launched view for a coordinator, or undefined; ambiguity is an unknown outcome. */
export async function exactView(
  cmd: TernCli,
  cwd: string,
  coordinator: Endpoint,
  kind: ViewKind,
  placement: Placement,
  args: readonly [string, string, string],
): Promise<LocatedBlock | undefined> {
  const session = Id.parse(coordinator.terminalSessionId);
  const { exact, ambiguous } = matchView(await listViews(cmd, cwd), {
    kind,
    placement,
    args,
    session,
    tab: coordinator.tabId,
  });
  if (ambiguous)
    throw new TernOutcomeUnknownError(
      "tern open",
      "native view placement or identity is ambiguous, detached or outside the owning window",
    );
  return exact;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readPrivateJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error("Invalid native opening evidence file");
  return JSON.parse(await readFile(path, "utf8"));
}

export type ObservedReceipt = Receipt | "torn" | undefined;

/** Tern's fs has no rename, so a receipt may be read mid-write. Only a whole receipt counts. */
export async function readReceipt(path: string): Promise<ObservedReceipt> {
  try {
    return Receipt.parse(await readPrivateJson(path));
  } catch (error) {
    return missing(error) ? undefined : "torn";
  }
}

async function writeTicket(path: string, ticket: Ticket): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(Ticket.parse(ticket)), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

/** One key per coordinator incarnation and project, so its tickets share one lock. */
function coordinatorKey(coordinator: Endpoint, ctx: Pick<BlockContext, "cwd" | "index">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        coordinator.sessionId,
        coordinator.terminalSessionId,
        coordinator.tabId,
        coordinator.paneId,
        coordinator.generation,
        ctx.cwd,
        ctx.index,
      ]),
    )
    .digest("hex");
}

function lockFor(directory: string, key: string, timeoutMs = 10000): Promise<() => Promise<void>> {
  return acquireDarwinFileLock(join(directory, `${key}.lock`), timeoutMs, 20);
}

/** `<key>.<token>.ticket.json` and its receipt, grouped by coordinator key. */
async function ticketNames(directory: string): Promise<Map<string, Set<string>>> {
  const names = await readdir(directory).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
  const keys = new Map<string, Set<string>>();
  for (const name of names) {
    const match = /^([\da-f]{64})\.([\da-f-]+)\.(?:ticket|receipt)\.json$/u.exec(name);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const tokens = keys.get(match[1]) ?? new Set<string>();
    tokens.add(match[2]);
    keys.set(match[1], tokens);
  }
  return keys;
}

type Recovery = Readonly<{
  /** A ticket settled as opened, so the view it opened may be reused. */
  opened: boolean;
  /** Why each remaining ticket still pauses new opens. */
  retained: readonly string[];
}>;

/** Decides every ticket under one key and applies it. The caller holds the key's lock. */
async function recoverKey(
  directory: string,
  key: string,
  tokens: ReadonlySet<string>,
  now: number,
  commandsFor: (ticket: Ticket) => TernCli,
): Promise<Recovery> {
  let opened = false;
  const retained: string[] = [];
  for (const token of [...tokens].toSorted()) {
    const stem = join(directory, `${key}.${token}`);
    let ticket: Ticket;
    try {
      ticket = Ticket.parse(await readPrivateJson(`${stem}${TICKET}`));
    } catch (error) {
      // A receipt whose ticket `tandem fix` abandoned has nothing left to settle.
      if (missing(error)) await rm(`${stem}${RECEIPT}`, { force: true });
      else retained.push("the view's ticket cannot be read");
      continue;
    }
    const receipt = await readReceipt(`${stem}${RECEIPT}`);
    const cwd = parseBlockArgs(ticket.args)?.ctx.cwd;
    let listing: ViewListing | undefined;
    if (
      cwd !== undefined &&
      receipt !== undefined &&
      receipt !== "torn" &&
      receipt.status === "done"
    )
      listing = await listViews(commandsFor(ticket), cwd, ticket.placement).catch(() => undefined);
    const decision = decide(ticket, receipt, listing, now);
    if (decision.action === "wait") retained.push("an earlier Tandem view is still opening");
    else if (decision.action === "quarantine") retained.push(decision.reason);
    else {
      if (decision.action === "settle" && decision.outcome === "opened") opened = true;
      // The ticket goes last, so an interrupted settle is decided again.
      await rm(`${stem}${RECEIPT}`, { force: true });
      await rm(`${stem}${TICKET}`, { force: true });
    }
  }
  return { opened, retained };
}

/**
 * Settles every ticket under `home` whose outcome is now decided and removes orphaned receipts.
 * The coordinator tick calls it, so a late receipt lifts a pause without another click. A key
 * whose lock an open holds is skipped, so a click never stalls publication; the next tick
 * decides it.
 */
export async function recoverViewOpens(
  commands: TernCli,
  home: string,
  now: number,
): Promise<void> {
  for (const directory of await openDirectories(home))
    for (const [key, tokens] of await ticketNames(directory)) {
      let release: () => Promise<void>;
      try {
        release = await lockFor(directory, key, 0);
      } catch (error) {
        if (error instanceof StoreLockTimeoutError) continue;
        throw error;
      }
      try {
        await recoverKey(directory, key, tokens, now, (ticket) => {
          const window = parseBlockArgs(ticket.args)?.ctx.window;
          return window === undefined ? commands : commands.scope({ windowKey: window });
        });
      } finally {
        await release();
      }
    }
}

export type OpenInput = Readonly<{
  coordinator: Endpoint;
  cwd: string;
  home: string;
  origin?: ViewOrigin;
  /** Whether a failed recovery may still return to the conversation. */
  returnToConversation: boolean;
}>;
export type OpenResult = {
  paneId: string;
  project: string;
  endpoint?: Endpoint;
  warnings?: string[];
};

/**
 * Opens one native view through a durable ticket, holding the coordinator's lock for the whole
 * call. Retained tickets are decided first; one still unresolved refuses the open.
 */
export async function openView(
  cmd: TernCli,
  input: OpenInput,
  project: string,
  kind: ViewKind,
  placement: Placement,
  viewPath: string,
): Promise<OpenResult> {
  const coordinator = ternEndpoint(input.coordinator);
  const index = viewIndexPath(input.home, project);
  const ctx: BlockContext = {
    coordinator: input.coordinator.paneId,
    cwd: input.cwd,
    home: input.home,
    index,
    ...(input.origin?.windowId === undefined ? {} : { window: input.origin.windowId }),
  };
  const args = blockArgs(viewPath, ctx);
  const resultFor = (entry: LocatedBlock): OpenResult => ({
    paneId: entry.block.id,
    project,
    ...(kind === "brief" && placement === "split"
      ? {
          endpoint: {
            terminal: "tern" as const,
            sessionId: input.coordinator.sessionId,
            terminalSessionId: entry.session.id,
            workspaceId: entry.tab.id,
            tabId: entry.tab.id,
            paneId: entry.block.id,
            role: input.coordinator.role,
            generation: input.coordinator.generation,
          },
        }
      : {}),
  });
  return withSettledOpens(
    cmd,
    input.coordinator,
    project,
    ctx,
    async ({ directory, key, opened }) => {
      const reused =
        placement === "panel" || placement === "split" || reusableRoots.includes(kind) || opened
          ? await exactView(cmd, input.cwd, input.coordinator, kind, placement, args)
          : undefined;
      if (reused !== undefined) {
        if (reusableRoots.includes(kind)) {
          const current = await exactView(cmd, input.cwd, input.coordinator, kind, placement, args);
          if (current?.block.id !== reused.block.id)
            throw new TernOutcomeUnknownError("tern open reuse", "native view identity changed");
          await cmd.mutate({
            verb: "focus",
            endpoint: ternEndpoint({
              ...input.coordinator,
              terminalSessionId: reused.session.id,
              workspaceId: reused.tab.id,
              tabId: reused.tab.id,
              paneId: reused.block.id,
            }),
            cwd: input.cwd,
          });
        }
        return resultFor(reused);
      }
      return dispatch(directory, key);
    },
    input.returnToConversation ? () => returnToConversation(cmd, input, project) : undefined,
  );

  async function dispatch(directory: string, key: string): Promise<OpenResult> {
    const closing = await closingOrigin(cmd, input, placement, index, project);
    const listed =
      placement === "task" || placement === "return" ? blocks(await cmd.ls(input.cwd)) : [];
    const ownedTasks = listed.filter((entry) => {
      const parsed = parseBlockArgs(entry.block.args);
      return (
        entry.tab.id === input.coordinator.tabId &&
        entry.block.program === "tandem.task" &&
        parsed?.ctx.coordinator === input.coordinator.paneId &&
        parsed.ctx.index === index
      );
    });
    if (ownedTasks.length > 1)
      throw new EndpointOwnershipError(
        input.coordinator,
        "several task blocks claim this coordinator",
      );
    const task = ownedTasks[0]?.block.id;
    // Cancelling the task picker closes only the picker and returns to the task it covered.
    const keepsTask =
      placement === "return" &&
      listed.some(
        (entry) =>
          entry.block.id === input.origin?.paneId && entry.block.program === "tandem.task-picker",
      );
    const token = randomUUID();
    const route = join(directory, `${key}.${token}${TICKET}`);
    const receiptPath = join(directory, `${key}.${token}${RECEIPT}`);
    const ticket: Ticket = {
      version: 1,
      kind,
      placement,
      args,
      coordinator: input.coordinator.paneId,
      origin: input.origin?.paneId ?? input.coordinator.paneId,
      session: Id.parse(input.coordinator.terminalSessionId),
      owner: {
        sessionId: input.coordinator.sessionId,
        workspaceId: input.coordinator.workspaceId,
        tabId: input.coordinator.tabId,
        generation: input.coordinator.generation,
      },
      receipt: receiptPath,
      ...(task === undefined ? {} : keepsTask ? { returnTo: task } : { replaced: task }),
      ...(closing === undefined ? {} : { closeOrigin: closing.endpoint.paneId }),
    };
    await writeTicket(route, ticket);
    let dispatched = false;
    try {
      // The last exact-id read before dispatch. A failure drops the claimed ticket.
      await cmd.exactPane({ endpoint: coordinator, cwd: input.cwd });
      const dispatchedTicket = { ...ticket, expiresAt: cmd.clock() + TICKET_LIFETIME_MS };
      await writeTicket(route, dispatchedTicket);
      dispatched = true;
      await cmd.mutate({ verb: "focus", endpoint: coordinator, cwd: input.cwd });
      // Freshly revealed background tabs receive their real window size asynchronously.
      await cmd.wait(150);
      const receipt = await cmd.mutate({
        verb: "open",
        endpoint: coordinator,
        cwd: input.cwd,
        route,
        receipt: receiptPath,
        ...(closing === undefined ? {} : { closes: closing }),
      });
      const listing =
        receipt.status === "done"
          ? await listViews(cmd, input.cwd, placement).catch(() => undefined)
          : undefined;
      const decision = decide(dispatchedTicket, receipt, listing, cmd.clock());
      if (decision.action !== "settle")
        throw new TernOutcomeUnknownError(
          "tern open",
          decision.action === "quarantine" ? decision.reason : "route receipt was not decided",
        );
      await rm(receiptPath, { force: true });
      await rm(route, { force: true });
      if (decision.outcome === "not-opened") throw new NativeViewNotOpenedError();
      if (decision.outcome === "closed") throw new NativeViewClosedError();
      return placement === "return" || placement === "inbox"
        ? { paneId: decision.block.block.id, project }
        : resultFor(decision.block);
    } catch (cause) {
      if (!dispatched) {
        await rm(route, { force: true });
        throw cause;
      }
      if (
        cause instanceof TernOutcomeUnknownError ||
        cause instanceof NativeViewNotOpenedError ||
        cause instanceof NativeViewClosedError
      )
        throw cause;
      throw new TernOutcomeUnknownError("tern open verification", cause);
    }
  }
}

/**
 * Holds a coordinator's open lock for the whole operation, after deciding its retained tickets.
 * One still unresolved refuses the operation unless `onRetained` offers a safe exit.
 */
export async function withSettledOpens<T>(
  cmd: TernCli,
  coordinator: Endpoint,
  project: string,
  ctx: Pick<BlockContext, "cwd" | "home" | "index">,
  operation: (lease: Readonly<{ directory: string; key: string; opened: boolean }>) => Promise<T>,
  onRetained?: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectoryTree(openDirectory(ctx.home, project), "native route directory");
  // Tern hands the plugin the opened path with symlinks resolved, and the plugin accepts a ticket
  // only when it names the receipt beside that path, so the ticket uses the resolved directory.
  const directory = await realpath(openDirectory(ctx.home, project));
  const key = coordinatorKey(coordinator, ctx);
  const release = await lockFor(directory, key);
  try {
    const recovery = await recoverKey(
      directory,
      key,
      (await ticketNames(directory)).get(key) ?? new Set(),
      cmd.clock(),
      () => cmd,
    ).catch((cause: unknown) => {
      throw new TernOutcomeUnknownError("tern open recovery", cause);
    });
    if (recovery.retained.length > 0) {
      if (onRetained !== undefined) return await onRetained();
      throw new TernOutcomeUnknownError("tern open recovery", recovery.retained.join("; "));
    }
    return await operation({ directory, key, opened: recovery.opened });
  } finally {
    await release();
  }
}

/**
 * Return stays a safe exit when an earlier open cannot be proved. Focus only the recorded
 * conversation and keep every resource.
 */
async function returnToConversation(
  cmd: TernCli,
  input: OpenInput,
  project: string,
): Promise<OpenResult> {
  await cmd.mutate({ verb: "focus", endpoint: ternEndpoint(input.coordinator), cwd: input.cwd });
  return {
    paneId: input.coordinator.paneId,
    project,
    warnings: [
      "Returned to your conversation. An earlier view could not be verified, so its views and recovery record were kept. Continue here or use Tern's tab switcher; opening new native views stays paused until exact recovery evidence is available.",
    ],
  };
}

/** A full-window view the return closes, proven exact and idle immediately before each effect. */
async function closingOrigin(
  cmd: TernCli,
  input: OpenInput,
  placement: Placement,
  index: string,
  project: string,
): Promise<ViewTarget | undefined> {
  const originId = input.origin?.paneId;
  if (placement !== "return" || originId === undefined || originId === input.coordinator.paneId)
    return undefined;
  const source = blocks(await cmd.ls(input.cwd)).find((entry) => entry.block.id === originId);
  const listed = parseBlockArgs(source?.block.args);
  if (
    source?.block.program === undefined ||
    listed === undefined ||
    !ViewKind.safeParse(source.block.program.slice("tandem.".length)).success ||
    !source.block.program.startsWith("tandem.") ||
    listed.ctx.coordinator !== input.coordinator.paneId ||
    listed.ctx.index !== index
  )
    throw new EndpointOwnershipError(
      input.coordinator,
      "return origin is not this coordinator's native view",
    );
  const kind = ViewKind.parse(source.block.program.slice("tandem.".length));
  if (!isWindowView(kind, listed.viewPath)) return undefined;
  const target: ViewTarget = {
    endpoint: {
      ...input.coordinator,
      paneId: source.block.id,
      workspaceId: source.tab.id,
      tabId: source.tab.id,
    },
    cwd: input.cwd,
    program: source.block.program,
    args: blockArgs(
      kind === "setup" ? viewDetailPath(input.home, project, setupFile("settings")) : index,
      {
        coordinator: input.coordinator.paneId,
        cwd: input.cwd,
        home: input.home,
        index,
        ...(listed.ctx.window === undefined ? {} : { window: listed.ctx.window }),
      },
    ),
  };
  await cmd.proveView(target);
  return target;
}

function retainedReason(receipt: ObservedReceipt): string {
  if (receipt === undefined) return "Tern never confirmed the view opened";
  if (receipt === "torn") return "the view's receipt cannot be read";
  if (receipt.status === "done")
    return "Tern reported the view opened, but the exact view could not be proved";
  return receipt.appliedEffects === 0
    ? `Tern failed before changing anything (${receipt.reason}); the next open settles it`
    : failureReason(receipt);
}

/** Every project's staged open tickets, read without changing anything. */
export async function listRetainedNativeOpens(home: string): Promise<RetainedViewOpen[]> {
  const opens: RetainedViewOpen[] = [];
  for (const directory of await openDirectories(home))
    for (const [key, tokens] of await ticketNames(directory))
      for (const token of [...tokens].toSorted()) {
        const stem = join(directory, `${key}.${token}`);
        const path = `${stem}${TICKET}`;
        try {
          const record = JSON.stringify(await readPrivateJson(path));
          const ticket = Ticket.parse(JSON.parse(record));
          const ctx = parseBlockArgs(ticket.args)?.ctx;
          if (ctx === undefined) throw new Error("Ticket arguments are not a native block's");
          opens.push({
            status: "readable",
            path,
            record,
            coordinator: {
              terminal: "tern",
              sessionId: ticket.owner.sessionId,
              terminalSessionId: ticket.session,
              workspaceId: ticket.owner.workspaceId,
              tabId: ticket.owner.tabId,
              paneId: ticket.coordinator,
              role: "coordinator",
              generation: ticket.owner.generation,
            },
            cwd: ctx.cwd,
            view: ticket.kind,
            reason: retainedReason(await readReceipt(`${stem}${RECEIPT}`)),
          });
        } catch (error) {
          // A receipt alone is an orphan the next recovery removes, not a paused view.
          if (missing(error)) continue;
          opens.push({
            status: "unreadable",
            path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
  return opens;
}

export const abandonRetainedNativeOpen: ViewsCapability["abandon"] = async (open, conclusive) => {
  const name = basename(open.path);
  const key = name.slice(0, name.indexOf("."));
  const directory = open.path.slice(0, open.path.length - name.length - 1);
  const release = await lockFor(directory, key);
  try {
    let record: string;
    try {
      record = JSON.stringify(await readPrivateJson(open.path));
    } catch (error) {
      if (missing(error)) return "settled";
      throw error;
    }
    if (record !== open.record) return "changed";
    if (!(await conclusive())) return "unproven";
    await rm(open.path.slice(0, -TICKET.length) + RECEIPT, { force: true });
    await rm(open.path, { force: true });
    return "abandoned";
  } finally {
    await release();
  }
};
