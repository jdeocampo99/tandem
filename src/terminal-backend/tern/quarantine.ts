import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { type Endpoint, MODEL_ROLE_ORDER } from "../../contracts.ts";
import type { TernOp } from "./cli.ts";
import { Id, TernOutcomeUnknownError, TernQuarantinedError } from "./protocol.ts";

const QUARANTINE_DIRECTORY = "tern-quarantine";
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

type Subject = Readonly<{ key: string; endpoint: Endpoint }>;
type Subjects = Readonly<{ refused: readonly Subject[]; recorded: Subject | undefined }>;
type PaneReference = "pane" | "owner" | "beside" | "closed" | "helper" | "split";

/** Focus converges; opens, creations and browser openings keep their own outcome policy. */
const SUBJECTS: Readonly<
  Record<
    TernOp["verb"],
    Readonly<{
      refused: readonly PaneReference[];
      recorded?: PaneReference;
    }>
  >
> = {
  focus: { refused: ["pane"] },
  run: { refused: ["pane"], recorded: "pane" },
  send: { refused: ["pane"], recorded: "pane" },
  rename: { refused: ["pane"], recorded: "pane" },
  split: { refused: ["pane", "split"], recorded: "split" },
  newTab: { refused: ["beside"] },
  newSession: { refused: [] },
  close: { refused: ["pane", "owner"], recorded: "pane" },
  killSession: { refused: ["closed"], recorded: "closed" },
  open: { refused: ["pane"] },
  browser: { refused: ["pane"] },
  notify: { refused: ["helper"], recorded: "helper" },
};

function paneKey(endpoint: Endpoint): string {
  return `pane:${endpoint.terminalSessionId ?? ""}:${endpoint.paneId}`;
}

function subjects(op: TernOp): Subjects {
  const endpoints = {
    pane: "endpoint" in op ? op.endpoint : undefined,
    owner: "owner" in op ? op.owner : undefined,
    beside:
      op.verb === "newTab" && op.beside !== undefined && "endpoint" in op.beside
        ? op.beside.endpoint
        : undefined,
    closed: "closed" in op ? op.closed : undefined,
    helper: "helper" in op ? op.helper : undefined,
  };
  const subject = (reference: PaneReference): Subject | undefined => {
    const endpoint = endpoints[reference === "split" ? "pane" : reference];
    if (endpoint === undefined) return undefined;
    return { key: `${reference === "split" ? "split:" : ""}${paneKey(endpoint)}`, endpoint };
  };
  const rule = SUBJECTS[op.verb];
  return {
    refused: rule.refused.map(subject).filter((each) => each !== undefined),
    recorded: rule.recorded === undefined ? undefined : subject(rule.recorded),
  };
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
  const { refused } = subjects(op);
  for (const { key } of refused) {
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
  const endpoints = refused.map((subject) => subject.endpoint);
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
  subject: Subject,
  mutation: Readonly<{ cwd: string; error: TernOutcomeUnknownError }>,
  clock: () => number,
): Promise<void> {
  const { error, cwd } = mutation;
  const directory = join(home, QUARANTINE_DIRECTORY);
  const file = quarantineFile(subject.key);
  const record: z.infer<typeof QuarantineRecord> = {
    version: 1,
    key: subject.key,
    operation: error.operation,
    reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
    at: new Date(clock()).toISOString(),
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
    if (!existsSync(join(directory, file))) continue;
    await withRecordLock(directory, file, () => rm(join(directory, file), { force: true }));
  }
}

/** A pane whose last Tandem effect ended with an unknown outcome, so Tandem refuses to touch it. */
export type QuarantinedPane =
  | Readonly<{
      status: "readable";
      path: string;
      /** The record exactly as listed, so a clear never removes one that changed since. */
      record: string;
      key: string;
      operation: string;
      reason: string;
      at: string;
      endpoint: Endpoint;
      cwd: string;
    }>
  | Readonly<{ status: "unreadable"; path: string; reason: string }>;

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
  pane: Readonly<{ path: string; record: string }>,
  conclusive: () => Promise<boolean>,
): Promise<"cleared" | "settled" | "changed" | "unproven"> {
  // A listed record's file name is its key's digest, the same lock every mutate of that pane takes.
  return withRecordLock(dirname(pane.path), basename(pane.path), async () => {
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

/** The durable pane policy for one Tandem home; it never runs a command. */
export function ternQuarantine(home: string | undefined, clock: () => number) {
  return {
    refuse: (op: TernOp) => refuseQuarantined(home, op),
    forget: (endpoint: Endpoint) => forgetQuarantine(home, endpoint),
    record: async (op: TernOp, error: unknown): Promise<void> => {
      if (
        home === undefined ||
        !(error instanceof TernOutcomeUnknownError) ||
        error instanceof TernQuarantinedError
      )
        return;
      const subject = subjects(op).recorded;
      if (subject === undefined) return;
      try {
        await recordQuarantine(home, subject, { cwd: op.cwd, error }, clock);
      } catch (cause) {
        throw new TernOutcomeUnknownError(
          error.operation,
          `${String(error.cause)}; its quarantine could not be recorded: ${String(cause)}`,
        );
      }
    },
  };
}
