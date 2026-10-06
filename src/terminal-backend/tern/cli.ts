import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CommandStartError,
  CommandTimeoutError,
  quoteShellCommand,
} from "../../adapters/commands.ts";
import {
  AdapterCommandError,
  AdapterError,
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import {
  type CommandResult,
  type CommandRunner,
  type Endpoint,
  MODEL_ROLE_ORDER,
} from "../../contracts.ts";
import type { Receipt } from "../../native/contract.ts";
import {
  type EndpointInspection,
  type EndpointTarget,
  isWorkerProcess,
  type QuarantinedPane,
  type TerminalAvailability,
} from "../contract.ts";
import type { TernEndpoint } from "../identity.ts";
import {
  BlockAck,
  blocks,
  Created,
  decode,
  Id,
  Listing,
  type LocatedBlock,
  Processes,
  SessionAck,
  type TernListing,
  TernOutcomeUnknownError,
  TernQuarantinedError,
} from "./protocol.ts";

/** The command runner. Only this module invokes it; every other module goes through `ternCli`. */
export type TernRunner = CommandRunner;
export const TERN_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

export function ternBinary(environment?: Readonly<Record<string, string>>): string {
  return Bun.which("tern", { PATH: environment?.PATH ?? process.env.PATH ?? "" }) ?? TERN_BINARY;
}

export type TernOptions = Readonly<{
  binary?: string;
  /** All reads and writes use the same explicit window scope, including absence proofs. */
  windowKey?: string;
  environment?: Readonly<Record<string, string>>;
  /** The Tandem home whose durable quarantine refuses a mutation and records an unknown one. */
  home?: string;
  clock?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

/** A Tandem block whose program and launch arguments must still match before it is touched. */
export type ViewTarget = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  program: string;
  args: readonly string[];
}>;

type Target = Readonly<{ endpoint: TernEndpoint; cwd: string }>;
type ShellLine =
  | Readonly<{ export: Readonly<Record<string, string>> }>
  | Readonly<{ command: readonly string[]; env?: Readonly<Record<string, string>> }>;

/** Every effect Tandem asks of Tern. Nothing outside this module spawns `tern`. */
export type TernOp =
  | (Target & Readonly<{ verb: "focus" }>)
  | (Target & Readonly<{ verb: "run"; line: ShellLine }>)
  | (Target &
      Readonly<{
        verb: "send";
        input: Readonly<{ keys: readonly string[] }> | Readonly<{ text: string }>;
      }>)
  | (Target & Readonly<{ verb: "rename"; label: string }>)
  | (Target & Readonly<{ verb: "split" }>)
  | Readonly<{
      verb: "newTab";
      cwd: string;
      session: string;
      /** A tab the session must still hold, or a pane whose session receives the tab. */
      beside?: Readonly<{ tab: string }> | Readonly<{ endpoint: TernEndpoint }>;
    }>
  | Readonly<{ verb: "newSession"; cwd: string; name: string }>
  | (Target &
      Readonly<{
        verb: "close";
        /** A native view must still be the exact launched block and have no process at all. */
        view?: Readonly<{ program: string; args: readonly string[] }>;
        /** The coordinator that owns this pane; its quarantine refuses the close too. */
        owner?: TernEndpoint;
        force?: boolean;
        /** An owned pane must be present; otherwise an absent pane is already closed. */
        owned?: boolean;
      }>)
  | Readonly<{
      verb: "killSession";
      cwd: string;
      session: string;
      /** The pane whose close emptied the session. */
      closed: TernEndpoint;
    }>
  | (Target &
      Readonly<{
        verb: "open";
        route: string;
        receipt: string;
        /** A full-window view the layout closes, proven exact and idle before the route runs. */
        closes?: ViewTarget;
      }>)
  | (Target & Readonly<{ verb: "browser"; url: URL }>)
  | Readonly<{
      verb: "notify";
      helper: TernEndpoint;
      cwd: string;
      title: string;
      body: string;
    }>;

type Verb = TernOp["verb"];
type Op<V extends Verb> = Extract<TernOp, { verb: V }>;
export type Closed = Readonly<{ absent: true }> | Readonly<{ absent: false; emptied?: string }>;
type Results = {
  focus: undefined;
  run: undefined;
  send: undefined;
  rename: undefined;
  split: z.infer<typeof Created>;
  newTab: z.infer<typeof Created>;
  newSession: z.infer<typeof Created>;
  close: Closed;
  killSession: undefined;
  open: Receipt;
  browser: string;
  notify: undefined;
};

/**
 * Whether an unknown outcome of each verb is recorded durably against its subject. A focus is
 * idempotent. Opens record their own outcome as a ticket, creations as their launch reservation,
 * and a browser opening is reported once and pauses nothing.
 */
const QUARANTINES: Readonly<Record<Verb, boolean>> = {
  focus: false,
  run: true,
  send: true,
  rename: true,
  split: true,
  newTab: false,
  newSession: false,
  close: true,
  killSession: true,
  open: false,
  browser: false,
  notify: true,
};

const READ_VERBS = ["ls", "process", "inspect"] as const;
type ReadArgs = readonly [(typeof READ_VERBS)[number], ...string[]];
const QUARANTINE_DIRECTORY = "tern-quarantine";
const RECEIPT_WAIT_MS = 5_000;
const Opened = z.object({
  blocks: z.array(z.union([Id, z.number().int().safe().positive().transform(String)])),
  discarded: z.boolean(),
});
const BrowserOpened = z.object({ ok: z.object({ block: Id }) });
const QuarantineRecord = z.object({
  version: z.literal(1),
  key: z.string(),
  operation: z.string(),
  reason: z.string(),
  at: z.string(),
  /** The exact pane the effect targeted, so `tandem fix` can prove it gone or idle. */
  endpoint: z.object({
    terminal: z.literal("tern"),
    sessionId: z.string(),
    terminalSessionId: Id.optional(),
    workspaceId: z.string(),
    tabId: z.string(),
    paneId: Id,
    role: z.enum(MODEL_ROLE_ORDER),
    generation: z.number().int().nonnegative(),
  }),
  cwd: z.string(),
});

export function missing(endpoint: Endpoint): EndpointOwnershipError {
  return new EndpointOwnershipError(
    endpoint,
    "exact Tern id absent from the same scoped listing",
    "missing",
  );
}

function paneKey(endpoint: Endpoint): string {
  return `pane:${endpoint.terminalSessionId ?? ""}:${endpoint.paneId}`;
}

type Subjects = Readonly<{
  /** Durable keys whose record refuses the op. */
  refused: readonly string[];
  /** The key and pane an unknown outcome of the op is recorded against. */
  recorded?: Readonly<{ key: string; endpoint: Endpoint }>;
}>;

function subjects(op: TernOp): Subjects {
  switch (op.verb) {
    case "split":
      return {
        refused: [paneKey(op.endpoint), `split:${paneKey(op.endpoint)}`],
        recorded: { key: `split:${paneKey(op.endpoint)}`, endpoint: op.endpoint },
      };
    case "newTab":
      return {
        refused:
          op.beside !== undefined && "endpoint" in op.beside ? [paneKey(op.beside.endpoint)] : [],
      };
    case "newSession":
      return { refused: [] };
    case "killSession":
      // The kill finishes the close of `closed`; its doubt belongs to that pane.
      return {
        refused: [paneKey(op.closed)],
        recorded: { key: paneKey(op.closed), endpoint: op.closed },
      };
    case "notify":
      return {
        refused: [paneKey(op.helper)],
        recorded: { key: paneKey(op.helper), endpoint: op.helper },
      };
    case "close":
      return {
        refused: [paneKey(op.endpoint), ...(op.owner === undefined ? [] : [paneKey(op.owner)])],
        recorded: { key: paneKey(op.endpoint), endpoint: op.endpoint },
      };
    default:
      return {
        refused: [paneKey(op.endpoint)],
        recorded: { key: paneKey(op.endpoint), endpoint: op.endpoint },
      };
  }
}

function endpointsOf(op: TernOp): readonly Endpoint[] {
  switch (op.verb) {
    case "newTab":
      return op.beside !== undefined && "endpoint" in op.beside ? [op.beside.endpoint] : [];
    case "newSession":
      return [];
    case "killSession":
      return [op.closed];
    case "notify":
      return [op.helper];
    case "close":
      return op.owner === undefined ? [op.endpoint] : [op.endpoint, op.owner];
    default:
      return [op.endpoint];
  }
}

function quarantineFile(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

/** One lock per record, shared by the writer, the absent-pane close and `tandem fix`. */
async function withRecordLock<T>(directory: string, file: string, body: () => Promise<T>) {
  // Loaded on use, as the coordinator notes are, to keep worker startup light.
  const [{ ensurePrivateDirectoryTree }, { acquireDarwinFileLock }] = await Promise.all([
    import("../../coordinator/lock.ts"),
    import("../../tasks/store-lock.ts"),
  ]);
  await ensurePrivateDirectoryTree(directory, "Tern quarantine directory");
  const release = await acquireDarwinFileLock(
    join(directory, `${file.slice(0, -".json".length)}.lock`),
    10_000,
    20,
  );
  try {
    return await body();
  } finally {
    await release();
  }
}

/** Refuses an op whose subject or coordinator holds a durable quarantine, in any process. */
async function refuseQuarantined(home: string | undefined, op: TernOp): Promise<void> {
  if (home === undefined) return;
  for (const key of subjects(op).refused) {
    let record: z.infer<typeof QuarantineRecord>;
    try {
      record = QuarantineRecord.parse(
        JSON.parse(await readFile(join(home, QUARANTINE_DIRECTORY, quarantineFile(key)), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new TernQuarantinedError(`tern ${op.verb}`, error);
    }
    throw new TernQuarantinedError(
      `tern ${op.verb}`,
      `an earlier ${record.operation} is quarantined: ${record.reason}`,
    );
  }
  const endpoints = endpointsOf(op);
  if (endpoints.length === 0) return;
  // Loaded on use: worker startup reaches this module and must not load coordinator storage.
  const { listCoordinatorQuarantineRecords } = await import("../../coordinator/quarantine.ts");
  const notes = await listCoordinatorQuarantineRecords(home);
  if (
    notes.some((note) =>
      endpoints.some(
        (endpoint) =>
          note.endpoint?.terminal === "tern" &&
          note.endpoint.paneId === endpoint.paneId &&
          note.endpoint.terminalSessionId === endpoint.terminalSessionId,
      ),
    )
  )
    throw new TernQuarantinedError(
      `tern ${op.verb}`,
      "an earlier coordinator effect is quarantined",
    );
}

async function recordQuarantine(
  home: string,
  subject: NonNullable<Subjects["recorded"]>,
  cwd: string,
  error: TernOutcomeUnknownError,
): Promise<void> {
  const directory = join(home, QUARANTINE_DIRECTORY);
  const file = quarantineFile(subject.key);
  const record: z.infer<typeof QuarantineRecord> = {
    version: 1,
    key: subject.key,
    operation: error.operation,
    reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
    at: new Date().toISOString(),
    endpoint: QuarantineRecord.shape.endpoint.parse(subject.endpoint),
    cwd,
  };
  await withRecordLock(directory, file, async () => {
    const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, file));
  });
}

/** An exact pane proven absent can never repeat the doubted effect, so its record goes. */
async function forgetQuarantine(home: string | undefined, endpoint: Endpoint): Promise<void> {
  if (home === undefined) return;
  const directory = join(home, QUARANTINE_DIRECTORY);
  for (const key of [paneKey(endpoint), `split:${paneKey(endpoint)}`]) {
    const file = quarantineFile(key);
    if (!(await Bun.file(join(directory, file)).exists())) continue;
    await withRecordLock(directory, file, () => rm(join(directory, file), { force: true }));
  }
}

/** Every record under `<home>/tern-quarantine/`, read without changing anything. */
export async function listTernQuarantine(home: string): Promise<QuarantinedPane[]> {
  const directory = join(home, QUARANTINE_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const panes: QuarantinedPane[] = [];
  for (const name of names.filter((each) => /^[\da-f]{64}\.json$/u.test(each)).toSorted()) {
    const path = join(directory, name);
    try {
      const record = await readFile(path, "utf8");
      const { endpoint, version: _version, ...parsed } = QuarantineRecord.parse(JSON.parse(record));
      const { terminalSessionId, ...placement } = endpoint;
      panes.push({
        status: "readable",
        path,
        record,
        ...parsed,
        endpoint: {
          ...placement,
          ...(terminalSessionId === undefined ? {} : { terminalSessionId }),
        },
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      panes.push({
        status: "unreadable",
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return panes;
}

/** Removes one record under its lock, only while it is unchanged and `conclusive` re-proves it. */
export async function clearTernQuarantine(
  pane: Extract<QuarantinedPane, Readonly<{ status: "readable" }>>,
  conclusive: () => Promise<boolean>,
): Promise<"cleared" | "settled" | "changed" | "unproven"> {
  const file = quarantineFile(pane.key);
  const directory = pane.path.slice(0, pane.path.length - file.length - 1);
  return withRecordLock(directory, file, async () => {
    let current: string;
    try {
      current = await readFile(pane.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "settled";
      throw error;
    }
    if (current !== pane.record) return "changed";
    if (!(await conclusive())) return "unproven";
    await rm(pane.path, { force: true });
    return "cleared";
  });
}

type Core = Readonly<{
  run: TernRunner;
  binary: string;
  windowKey: string | undefined;
  environment: Readonly<Record<string, string>> | undefined;
  home: string | undefined;
  clock: () => number;
  wait: (milliseconds: number) => Promise<void>;
}>;

function request(core: Core, cwd: string, args: readonly string[], timeoutMs?: number) {
  return {
    argv: [
      core.binary,
      ...args,
      ...(core.windowKey === undefined ? [] : ["--window", core.windowKey]),
      "--json",
    ],
    cwd,
    ...(core.environment === undefined ? {} : { env: core.environment }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

async function query<S extends z.ZodType>(
  core: Core,
  cwd: string,
  args: readonly string[],
  schema: S,
  timeoutMs?: number,
): Promise<z.infer<S>> {
  const req = request(core, cwd, args, timeoutMs);
  const result = await core.run(req);
  if (result.code !== 0) throw new AdapterCommandError(`tern ${args[0]}`, req, result);
  return decode(result.stdout, schema, `tern ${args[0]}`);
}

/** Even a failed CLI response can follow a completed daemon effect. Never retry it here. */
async function spawn<S extends z.ZodType>(
  core: Core,
  cwd: string,
  args: readonly string[],
  schema: S,
): Promise<z.infer<S>> {
  try {
    return await query(core, cwd, args, schema);
  } catch (cause) {
    throw new TernOutcomeUnknownError(`tern ${args[0]}`, cause);
  }
}

async function ls(core: Core, cwd: string, timeoutMs?: number): Promise<TernListing> {
  const listing = await query(core, cwd, ["ls"], Listing, timeoutMs);
  const ids = listing.sessions.flatMap((s) => [
    s.id,
    ...s.tabs.flatMap((t) => [t.id, ...t.blocks.map((b) => b.id)]),
  ]);
  if (new Set(ids).size !== ids.length)
    throw new AdapterProtocolError("tern ls", "duplicate identities", "");
  return listing;
}

async function exactPane(core: Core, target: EndpointTarget): Promise<LocatedBlock> {
  const { endpoint } = target;
  const listing = await ls(core, target.cwd);
  const found = blocks(listing).find((entry) => entry.block.id === endpoint.paneId);
  if (found === undefined && listing.detached.length > 0)
    throw new EndpointOwnershipError(
      endpoint,
      "detached Tern blocks leave the pane's placement ambiguous",
    );
  if (found === undefined) throw missing(endpoint);
  if (endpoint.terminalSessionId !== undefined && found.session.id !== endpoint.terminalSessionId)
    throw new EndpointOwnershipError(endpoint, "Tern session identity changed");
  if (found.tab.id !== endpoint.workspaceId || found.tab.id !== endpoint.tabId) {
    throw new EndpointOwnershipError(endpoint, "Tern tab identity changed");
  }
  return found;
}

async function readForegroundGroup(core: Core, cwd: string, group: number) {
  const req = {
    argv: [
      process.execPath,
      fileURLToPath(new URL("./process-reader.ts", import.meta.url)),
      String(group),
    ],
    cwd,
  };
  const result = await core.run(req);
  if (result.code !== 0)
    throw new AdapterCommandError("Tern foreground process proof", req, result);
  return decode(
    result.stdout,
    z.array(
      z.object({ pid: z.number().int().positive(), name: z.string(), argv: z.array(z.string()) }),
    ),
    "Tern foreground process proof",
  );
}

async function inspect(core: Core, target: EndpointTarget): Promise<EndpointInspection> {
  const found = await exactPane(core, target);
  const processArgs = ["process", target.endpoint.paneId];
  let proc = await query(core, target.cwd, processArgs, Processes);
  let nativeProcesses: readonly { pid: number; name: string; argv: string[] }[] = [];
  for (let attempt = 0; ; attempt += 1) {
    if (proc.pane !== target.endpoint.paneId)
      throw new EndpointOwnershipError(target.endpoint, "Tern process response names another pane");
    try {
      nativeProcesses =
        proc.group === null ? [] : await readForegroundGroup(core, target.cwd, proc.group);
      if (
        proc.foreground !== null &&
        !nativeProcesses.some(
          (entry) =>
            entry.pid === proc.foreground?.pid &&
            JSON.stringify(entry.argv) === JSON.stringify(proc.foreground.argv),
        )
      )
        throw new AdapterProtocolError(
          "Tern foreground process proof",
          "Tern leader and native group evidence disagree",
          "",
        );
      break;
    } catch (error) {
      if (!(error instanceof AdapterProtocolError || error instanceof AdapterCommandError))
        throw error;
      // A shell can exec or switch foreground groups between the two independent reads.
      // Retry reads only when fresh exact-pane evidence proves the process snapshot changed.
      // A stable disagreement still fails closed, as does continuous churn.
      await exactPane(core, target);
      const current = await query(core, target.cwd, processArgs, Processes);
      if (attempt >= 2 || JSON.stringify(current) === JSON.stringify(proc)) throw error;
      proc = current;
    }
  }
  const foregroundProcesses = nativeProcesses.map((entry) => ({
    ...entry,
    argv0: entry.argv[0],
    commandLine: undefined,
  }));
  // Daemon-hosted Tandem blocks have no PTY. Only the native program identity proves
  // this exception; a title or partial/contradictory process response never does.
  const tandemBlock =
    /^tandem\.[a-z][a-z0-9-]*$/u.test(found.block.program ?? "") &&
    proc.child === null &&
    proc.group === null &&
    proc.foreground === null;
  // A live pane without native process evidence is ambiguous, never assumed idle.
  if (found.block.live && proc.child === null && !tandemBlock)
    throw new AdapterProtocolError("tern process", "live block has no child process", "");
  return {
    endpoint: target.endpoint,
    pane: {
      paneId: found.block.id,
      workspaceId: found.tab.id,
      tabId: found.tab.id,
      foregroundCwd: proc.foreground?.cwd ?? proc.child?.cwd ?? found.block.cwd,
    },
    processInfo: {
      paneId: proc.pane,
      shellPid: proc.child?.pid,
      foregroundProcessGroupId: proc.group ?? undefined,
      foregroundProcesses,
    },
    activeWorker:
      (proc.foreground !== null && proc.child !== null && proc.foreground.pid !== proc.child.pid) ||
      foregroundProcesses.some(isWorkerProcess) ||
      (found.block.live && proc.foreground === null && !tandemBlock) ||
      (proc.child !== null &&
        isWorkerProcess({ ...proc.child, argv0: proc.child.argv[0], commandLine: undefined })),
  };
}

/** The exact launched view with no process at all, proven on both sides of the process read. */
async function proveView(core: Core, target: ViewTarget): Promise<LocatedBlock> {
  const proveIdentity = async () => {
    const current = await exactPane(core, target);
    if (
      current.block.program !== target.program ||
      JSON.stringify(current.block.args) !== JSON.stringify(target.args)
    )
      throw new EndpointOwnershipError(target.endpoint, "pane is not the exact native view");
    return current;
  };
  await proveIdentity();
  const proc = await query(core, target.cwd, ["process", target.endpoint.paneId], Processes);
  if (
    proc.pane !== target.endpoint.paneId ||
    proc.child !== null ||
    proc.foreground !== null ||
    proc.group !== null
  )
    throw new EndpointBusyError(target.endpoint);
  return proveIdentity();
}

function environmentAssignments(endpoint: Endpoint, env?: Readonly<Record<string, string>>) {
  return Object.entries({
    ...env,
    TANDEM_SESSION: endpoint.sessionId,
    TANDEM_TERN_WORKSPACE_ID: endpoint.workspaceId,
    TERN_PANE: endpoint.paneId,
  }).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new TypeError(`invalid environment key ${key}`);
    return `${key}=${value}`;
  });
}

async function paneEffect(
  core: Core,
  op: Op<"focus" | "run" | "send" | "rename">,
  args: readonly string[],
) {
  await exactPane(core, op);
  await refuseQuarantined(core.home, op);
  const ack = await spawn(core, op.cwd, args, BlockAck);
  if (ack.block !== op.endpoint.paneId)
    throw new TernOutcomeUnknownError(`tern ${args[0]}`, "acknowledgement names another block");
}

/** A created block must be listed where Tern said it went, in a tab and pane that are new. */
async function confirmCreated(
  core: Core,
  cwd: string,
  created: z.infer<typeof Created>,
  before: TernListing,
  operation: string,
) {
  try {
    if (blocks(before).some((entry) => entry.block.id === created.block))
      throw new Error("acknowledged block existed before the creation");
    const entry = blocks(await ls(core, cwd)).find((each) => each.block.id === created.block);
    if (entry?.session.id !== created.session || entry.tab.id !== created.tab)
      throw new Error("created block acknowledgement disagrees with listing");
  } catch (cause) {
    throw new TernOutcomeUnknownError(`${operation} verification`, cause);
  }
}

const handlers: { [V in Verb]: (core: Core, op: Op<V>) => Promise<Results[V]> } = {
  focus: async (core, op) => {
    await paneEffect(core, op, ["focus", op.endpoint.paneId]);
    return undefined;
  },
  run: async (core, op) => {
    const assignments = environmentAssignments(
      op.endpoint,
      "export" in op.line ? op.line.export : op.line.env,
    );
    const command = quoteShellCommand(
      "export" in op.line
        ? ["export", ...assignments]
        : assignments.length === 0
          ? op.line.command
          : ["env", ...assignments, ...op.line.command],
    );
    await paneEffect(core, op, ["run", op.endpoint.paneId, command]);
    return undefined;
  },
  send: async (core, op) => {
    await paneEffect(
      core,
      op,
      "keys" in op.input
        ? ["send", op.endpoint.paneId, "keys", ...op.input.keys]
        : ["send", op.endpoint.paneId, "text", op.input.text],
    );
    return undefined;
  },
  rename: async (core, op) => {
    await paneEffect(core, op, ["rename", op.endpoint.paneId, op.label]);
    try {
      const tab = blocks(await ls(core, op.cwd)).find(
        (entry) => entry.tab.id === op.endpoint.tabId,
      )?.tab;
      if (tab?.name !== op.label) throw new Error("new tab label not confirmed");
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern rename verification", cause);
    }
    return undefined;
  },
  split: async (core, op) => {
    const placement = await exactPane(core, op);
    await refuseQuarantined(core.home, op);
    const before = await ls(core, op.cwd);
    const created = await spawn(
      core,
      op.cwd,
      ["split", op.endpoint.paneId, "right", "--cwd", op.cwd],
      Created,
    );
    if (
      created.session !== placement.session.id ||
      created.tab !== op.endpoint.tabId ||
      created.block === op.endpoint.paneId
    )
      throw new TernOutcomeUnknownError("tern split", "split did not land beside the exact anchor");
    await confirmCreated(core, op.cwd, created, before, "tern split");
    return created;
  },
  newTab: async (core, op) => {
    const beside = op.beside;
    if (beside !== undefined && "endpoint" in beside) {
      if (
        (await exactPane(core, { endpoint: beside.endpoint, cwd: op.cwd })).session.id !==
        op.session
      )
        throw new EndpointOwnershipError(beside.endpoint, "Tern session identity changed");
    }
    const before = await ls(core, op.cwd);
    const session = before.sessions.find((entry) => entry.id === op.session);
    if (session === undefined)
      throw new AdapterProtocolError("tern new tab", "exact Tern session is absent", "");
    if (beside !== undefined && "tab" in beside && !session.tabs.some((t) => t.id === beside.tab))
      throw new AdapterProtocolError("tern new tab", "exact parent Tern tab moved", "");
    await refuseQuarantined(core.home, op);
    const created = await spawn(core, op.cwd, ["new", "tab", op.session, "--cwd", op.cwd], Created);
    if (created.session !== op.session)
      throw new TernOutcomeUnknownError("tern new tab", "new tab belongs to another session");
    if (before.sessions.some((entry) => entry.tabs.some((tab) => tab.id === created.tab)))
      throw new TernOutcomeUnknownError("tern new tab", "acknowledged tab existed before");
    await confirmCreated(core, op.cwd, created, before, "tern new tab");
    return created;
  },
  newSession: async (core, op) => {
    const before = await ls(core, op.cwd);
    await refuseQuarantined(core.home, op);
    const created = await spawn(
      core,
      op.cwd,
      ["new", "session", op.name, "--cwd", op.cwd],
      Created,
    );
    if (before.sessions.some((entry) => entry.id === created.session))
      throw new TernOutcomeUnknownError("tern new session", "acknowledged session existed before");
    await confirmCreated(core, op.cwd, created, before, "tern new session");
    return created;
  },
  close: async (core, op) => {
    let before: LocatedBlock;
    if (op.view !== undefined) {
      const listing = await ls(core, op.cwd);
      if (!blocks(listing).some((entry) => entry.block.id === op.endpoint.paneId)) {
        if (listing.detached.length > 0)
          throw new EndpointOwnershipError(op.endpoint, "detached panes make closure ambiguous");
        // A window-scoped listing cannot see other windows, so it never proves the pane is gone.
        if (core.windowKey === undefined) await forgetQuarantine(core.home, op.endpoint);
        return { absent: true };
      }
      before = await proveView(core, { ...op.view, endpoint: op.endpoint, cwd: op.cwd });
    } else {
      let initial: EndpointInspection;
      try {
        initial = await inspect(core, op);
      } catch (error) {
        if (
          op.owned !== true &&
          error instanceof EndpointOwnershipError &&
          error.reason === "missing"
        ) {
          // exactPane reports missing only from an exact scoped listing with no detached blocks.
          if (core.windowKey === undefined) await forgetQuarantine(core.home, op.endpoint);
          return { absent: true };
        }
        throw error;
      }
      if (initial.activeWorker && op.force !== true) throw new EndpointBusyError(op.endpoint);
      // This is the last call before close: recheck the exact identity, never use a title fallback.
      before = await exactPane(core, op);
    }
    await refuseQuarantined(core.home, op);
    const ack = await spawn(core, op.cwd, ["close", op.endpoint.paneId], BlockAck);
    if (ack.block !== op.endpoint.paneId)
      throw new TernOutcomeUnknownError("tern close", "acknowledgement names another block");
    try {
      const after = await ls(core, op.cwd);
      if (after.detached.length > 0) throw new Error("detached blocks prevent exact absence proof");
      if (blocks(after).some((entry) => entry.block.id === op.endpoint.paneId))
        throw new Error("closed block remains present");
      const session = after.sessions.find((entry) => entry.id === before.session.id);
      return session === undefined || session.tabs.some((tab) => tab.blocks.length > 0)
        ? { absent: false }
        : { absent: false, emptied: session.id };
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern close verification", cause);
    }
  },
  killSession: async (core, op) => {
    // Empty sessions survive the last close in Tern. Recheck exact id and emptiness before kill.
    const rechecked = (await ls(core, op.cwd)).sessions.find((entry) => entry.id === op.session);
    if (rechecked === undefined || rechecked.tabs.some((tab) => tab.blocks.length > 0))
      return undefined;
    await refuseQuarantined(core.home, op);
    const killed = await spawn(core, op.cwd, ["kill", "session", op.session], SessionAck);
    try {
      if (killed.session !== op.session) throw new Error("kill acknowledged another session");
      const deadline = core.clock() + 5_000;
      for (;;) {
        const remaining = deadline - core.clock();
        if (remaining <= 0)
          throw new Error("killed session cleanup was not confirmed before timeout");
        const listing = await ls(core, op.cwd, remaining);
        if (listing.detached.length > 0)
          throw new Error("detached blocks prevent exact session absence proof");
        const retained = listing.sessions.find((entry) => entry.id === op.session);
        // Tern keeps its last session alive. Exact ack plus no tabs/panes is known cleanup.
        if (retained === undefined || retained.tabs.length === 0) return undefined;
        if (retained.tabs.some((tab) => tab.blocks.length > 0))
          throw new Error("killed session acquired panes");
        await core.wait(Math.min(100, Math.max(0, deadline - core.clock())));
      }
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern close verification", cause);
    }
  },
  open: async (core, op) => {
    await exactPane(core, op);
    if (op.closes !== undefined) await proveView(core, op.closes);
    await refuseQuarantined(core.home, op);
    let acknowledged: readonly string[] = [];
    try {
      const outcome = await core.run(request(core, op.cwd, ["open", op.route]));
      if (outcome.code === 0) acknowledged = Opened.parse(JSON.parse(outcome.stdout)).blocks;
      else if (!outcome.stderr.includes("cannot open in a file block"))
        throw new Error(outcome.stderr);
      // Tern's CLI reports handled custom layout routes as no file block. Only the receipt
      // and the exact listing decide; an exit-0 block list is corroboration.
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern open", cause);
    }
    // Loaded on use: only a native view open reads a receipt.
    const { readReceipt } = await import("./host.ts");
    const deadline = core.clock() + RECEIPT_WAIT_MS;
    while (core.clock() < deadline) {
      const receipt = await readReceipt(op.receipt);
      if (receipt !== undefined && receipt !== "torn") {
        if (
          receipt.status === "done" &&
          acknowledged.length > 0 &&
          !acknowledged.includes(receipt.paneId)
        )
          throw new TernOutcomeUnknownError("tern open", "acknowledgement names another block");
        return receipt;
      }
      await core.wait(50);
    }
    throw new TernOutcomeUnknownError(
      "tern open",
      "route receipt was not confirmed; keep route and resources",
    );
  },
  browser: async (core, op) => {
    const owner = Number(op.endpoint.paneId);
    if (!Number.isSafeInteger(owner))
      throw new Error("Browser owner id is not exactly representable");
    const before = blocks(await ls(core, op.cwd));
    await exactPane(core, op);
    await refuseQuarantined(core.home, op);
    const opened = await spawn(
      core,
      op.cwd,
      ["browser", JSON.stringify({ op: "open", owner, url: op.url.href })],
      BrowserOpened,
    );
    try {
      const listing = await ls(core, op.cwd);
      const created = blocks(listing).find((entry) => entry.block.id === opened.ok.block);
      if (
        listing.detached.length > 0 ||
        !created ||
        created.session.id !== op.endpoint.terminalSessionId ||
        before.some((entry) => entry.block.id === opened.ok.block)
      )
        throw new Error("new browser identity was not confirmed");
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern browser", cause);
    }
    return opened.ok.block;
  },
  notify: async (core, op) => {
    const target = { endpoint: op.helper, cwd: op.cwd };
    const inspected = await inspect(core, target);
    if (inspected.activeWorker) throw new EndpointBusyError(op.helper);
    const pid = inspected.processInfo.shellPid;
    if (pid === undefined)
      throw new AdapterError("Tern alert pane has no tty process", "tern notify");
    const tty = await core.run({ argv: ["ps", "-o", "tty=", "-p", String(pid)], cwd: op.cwd });
    const name = tty.stdout.trim();
    if (tty.code !== 0 || !/^ttys\d+$/u.test(name))
      throw new AdapterError("Tern alert tty could not be proven", "tern notify");
    const clean = (text: string) =>
      [...text]
        .map((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159) || char === ";" ? " " : char;
        })
        .join("");
    const osc = `\x1b]777;notify;${clean(op.title)};${clean(op.body)}\x07`;
    if ((await inspect(core, target)).processInfo.shellPid !== pid)
      throw new EndpointOwnershipError(op.helper, "notification tty process changed");
    await exactPane(core, target);
    await refuseQuarantined(core.home, op);
    let written: CommandResult;
    try {
      written = await core.run({
        argv: [
          process.execPath,
          "-e",
          "await Bun.write(Bun.file(process.argv[1]), process.argv[2]);",
          `/dev/${name}`,
          osc,
        ],
        cwd: op.cwd,
      });
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern notify", cause);
    }
    if (written.code !== 0) throw new TernOutcomeUnknownError("tern notify", "tty write failed");
    return undefined;
  },
};

/**
 * The only path to a Tern effect: exact-id recheck, a busy proof for destructive ops, the durable
 * quarantine read, the spawn, then the acknowledged-id check. An unknown outcome throws
 * `TernOutcomeUnknownError` and, for verbs that quarantine, is recorded against its subject.
 */
async function mutate<O extends TernOp>(core: Core, op: O): Promise<Results[O["verb"]]> {
  const handler = handlers[op.verb] as (core: Core, op: O) => Promise<Results[O["verb"]]>;
  try {
    return await handler(core, op);
  } catch (error) {
    const subject = subjects(op).recorded;
    if (
      error instanceof TernOutcomeUnknownError &&
      QUARANTINES[op.verb] &&
      subject !== undefined &&
      core.home !== undefined &&
      !(error instanceof TernQuarantinedError)
    ) {
      try {
        await recordQuarantine(core.home, subject, op.cwd, error);
      } catch (cause) {
        throw new TernOutcomeUnknownError(
          error.operation,
          `${String(error.cause)}; its quarantine could not be recorded: ${String(cause)}`,
        );
      }
    }
    throw error;
  }
}

export type TernCli = Readonly<{
  binary: string;
  clock: () => number;
  wait: (milliseconds: number) => Promise<void>;
  /** Whether reads see one window only, so they cannot prove absence everywhere. */
  windowed: boolean;
  /** The same Tern, scoped to another window or Tandem home. */
  scope: (change: Readonly<{ windowKey?: string; home?: string }>) => TernCli;
  /** The same Tern, reading every window. */
  unscoped: () => TernCli;
  ls: (cwd: string, timeoutMs?: number) => Promise<TernListing>;
  read: <S extends z.ZodType>(cwd: string, args: ReadArgs, schema: S) => Promise<z.infer<S>>;
  exactPane: (target: EndpointTarget) => Promise<LocatedBlock>;
  inspect: (target: EndpointTarget) => Promise<EndpointInspection>;
  proveView: (target: ViewTarget) => Promise<LocatedBlock>;
  mutate: <O extends TernOp>(op: O) => Promise<Results[O["verb"]]>;
  serverCommand: () => string[];
  clientCommand: () => string[];
}>;

function facade(core: Core): TernCli {
  return {
    binary: core.binary,
    clock: core.clock,
    wait: core.wait,
    windowed: core.windowKey !== undefined,
    scope: (change) =>
      facade({
        ...core,
        ...(change.windowKey === undefined ? {} : { windowKey: change.windowKey }),
        ...(change.home === undefined ? {} : { home: change.home }),
      }),
    unscoped: () => facade({ ...core, windowKey: undefined }),
    ls: (cwd, timeoutMs) => ls(core, cwd, timeoutMs),
    read: (cwd, args, schema) => query(core, cwd, args, schema),
    exactPane: (target) => exactPane(core, target),
    inspect: (target) => inspect(core, target),
    proveView: (target) => proveView(core, target),
    mutate: (op) => mutate(core, op),
    serverCommand: () => [core.binary, "daemon"],
    clientCommand: () => [core.binary],
  };
}

export function ternCli(run: TernRunner, options: TernOptions = {}): TernCli {
  return facade({
    run,
    binary: options.binary ?? ternBinary(options.environment),
    windowKey: options.windowKey,
    environment: options.environment,
    home: options.home,
    clock: options.clock ?? Date.now,
    wait: options.wait ?? Bun.sleep,
  });
}

export type TernPluginCommand = Readonly<{
  run: TernRunner;
  cwd: string;
  binary?: string;
  env?: Readonly<Record<string, string>>;
}>;

/** `tern plugin <args> --json`, which changes only Tern's own plugin configuration. */
export async function ternPlugin(input: TernPluginCommand, args: readonly string[]) {
  const req = {
    argv: [input.binary ?? ternBinary(input.env), "plugin", ...args, "--json"],
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  const result = await input.run(req);
  if (result.code !== 0) throw new AdapterCommandError("Tern plugin", req, result);
  return result.stdout;
}

export type TernAvailabilityOptions = Readonly<{
  binary?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}>;
const PROBE_TIMEOUT_MS = 8_000;
const CONTROL_TIMEOUT_MS = 1_000;

function missingExecutable(error: unknown): boolean {
  return (
    (error instanceof CommandStartError && error.message.includes("Executable not found")) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
  );
}

/** The native account gate requires a brief owned window; headless Tern uses synthetic accounts. */
export async function probeTern(
  run: TernRunner,
  options: TernAvailabilityOptions = {},
): Promise<TerminalAvailability> {
  const binary = options.binary ?? Bun.which("tern") ?? TERN_BINARY;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + PROBE_TIMEOUT_MS;
  const budgetStop = new AbortController();
  const budgetTimer = setTimeout(() => budgetStop.abort(), PROBE_TIMEOUT_MS);
  const daemonStop = new AbortController();
  const windowStop = new AbortController();
  let root: string | undefined;
  let daemon: Promise<unknown> | undefined;
  let window: Promise<unknown> | undefined;
  let quit: (() => ReturnType<TernRunner>) | undefined;
  let result: TerminalAvailability;
  let cleanupFailed = false;
  let quitFailed = false;
  let timedOut = false;
  const remaining = () => {
    const milliseconds = deadline - now();
    if (milliseconds <= 0) budgetStop.abort();
    budgetStop.signal.throwIfAborted();
    return milliseconds;
  };
  const check = async (): Promise<TerminalAvailability> => {
    try {
      const version = await run({
        argv: [binary, "--version"],
        cwd: tmpdir(),
        timeoutMs: Math.min(3_000, remaining()),
        signal: budgetStop.signal,
      });
      if (version.code === 127) return { status: "missing" };
      if (version.code !== 0)
        return { status: "unknown", reason: "Tern's installation could not be confirmed." };
    } catch (error) {
      if (missingExecutable(error)) return { status: "missing" };
      throw error;
    }
    // Retain the allocation before realpath, so even a canonicalization failure is cleaned up.
    root = await mkdtemp(join(tmpdir(), "td-tern-"));
    root = await realpath(root);
    const cwd = root;
    const control = join(cwd, "c.sock");
    const env = {
      TERN_CONFIG_DIR: join(cwd, "config"),
      TERN_DAEMON_SOCKET: join(cwd, "d.sock"),
      TANDEM_HOME: join(cwd, "home"),
      ZDOTDIR: join(cwd, "zdot"),
      STENCIL_LOG_DIR: join(cwd, "logs"),
    };
    const call = (args: readonly string[]) =>
      run({
        argv: [binary, ...args],
        cwd,
        env,
        timeoutMs: Math.min(CONTROL_TIMEOUT_MS, remaining()),
        signal: budgetStop.signal,
      });
    await Promise.all(
      Object.values(env)
        .filter((path) => path !== env.TERN_DAEMON_SOCKET)
        .map((path) => mkdir(path)),
    );
    daemon = run({
      argv: [binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET],
      cwd,
      env,
      signal: AbortSignal.any([daemonStop.signal, budgetStop.signal]),
      timeoutMs: remaining(),
    }).catch(() => undefined);
    let ready = false;
    const daemonDeadline = Math.min(deadline, now() + 2_000);
    while (now() < daemonDeadline) {
      try {
        ready = (await call(["ls", "--json"])).code === 0;
      } catch {
        /* Daemon is starting; its deadline still applies. */
      }
      if (ready) break;
      await sleep(50);
    }
    if (!ready) return { status: "unknown", reason: "Tern could not start in time." };
    // This is our own control socket. A failed quit still falls back to owned process-group abort.
    quit = async () =>
      run({
        argv: [binary, "ctl", "--control", control, "quit"],
        cwd,
        env,
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
    window = run({
      argv: [binary, "--control", control, "--dir", cwd],
      cwd,
      env,
      signal: AbortSignal.any([windowStop.signal, budgetStop.signal]),
      timeoutMs: remaining(),
    }).catch(() => undefined);
    const windowDeadline = Math.min(deadline, now() + 3_000);
    while (now() < windowDeadline) {
      try {
        const response = await call(["ctl", "--control", control, "state"]);
        if (response.code === 0) {
          const value: unknown = JSON.parse(response.stdout);
          if (typeof value === "object" && value !== null && "gate" in value) {
            const gate = value.gate;
            if (typeof gate === "object" && gate !== null && "signed_in" in gate) {
              if (gate.signed_in === true) return { status: "ready" };
              if (gate.signed_in === false) return { status: "signedOut" };
            }
          }
        }
      } catch {
        /* The isolated window is starting; its deadline still applies. */
      }
      await sleep(50);
    }
    return { status: "unknown", reason: "Tern's sign-in state could not be confirmed in time." };
  };
  try {
    result = await check();
  } catch (error) {
    result = {
      status: "unknown",
      reason:
        error instanceof CommandTimeoutError
          ? "Tern's availability check timed out."
          : "Tern could not be checked.",
    };
  } finally {
    timedOut = budgetStop.signal.aborted || now() >= deadline;
    clearTimeout(budgetTimer);
    if (quit !== undefined)
      quitFailed = await quit().then(
        (response) => response.code !== 0,
        () => true,
      );
    windowStop.abort();
    daemonStop.abort();
    await Promise.allSettled([window, daemon]);
    if (root !== undefined)
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
  }
  if (cleanupFailed)
    return {
      status: "unknown",
      reason: "Tern's availability check could not clean up its temporary files.",
    };
  if (quitFailed)
    return { status: "unknown", reason: "Tern's availability window could not close normally." };
  return timedOut ? { status: "unknown", reason: "Tern's availability check timed out." } : result;
}
