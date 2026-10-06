import { z } from "zod";
import {
  AdapterCommandError,
  AdapterError,
  AdapterProtocolError,
} from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";

export const TERN_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";
export const Id = z.string().regex(/^[1-9]\d*$/u);
const Block = z.object({
  id: Id,
  title: z.string(),
  cwd: z.string(),
  live: z.boolean(),
  cols: z.number().optional(),
  program: z.string().optional(),
  args: z.array(z.string()).optional(),
});
const Tab = z.object({ id: Id, name: z.string().nullable(), blocks: z.array(Block) });
const Session = z.object({ id: Id, name: z.string(), tabs: z.array(Tab) });
export const Listing = z.object({ sessions: z.array(Session), detached: z.array(z.unknown()) });
const Process = z.object({
  pid: z.number().int().positive(),
  name: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
});
export const Processes = z.object({
  pane: Id,
  child: Process.nullable(),
  group: z.number().int().positive().nullable(),
  foreground: Process.nullable(),
});
export const Created = z.object({ session: Id, tab: Id, block: Id });
export const BlockAck = z.object({ block: Id });
export const SessionAck = z.object({ session: Id });
export type TernListing = z.infer<typeof Listing>;
export type LocatedBlock = Readonly<{
  session: z.infer<typeof Session>;
  tab: z.infer<typeof Tab>;
  block: z.infer<typeof Block>;
}>;

/** Unknown mutation outcomes must leave resources with their durable owner. */
export class TernOutcomeUnknownError extends AdapterError {
  constructor(operation: string, cause: unknown) {
    super(`${operation} outcome is unknown; quarantine and keep resources`, operation, cause);
    this.name = "TernOutcomeUnknownError";
  }
}

/** Native views arrive in wave 2. Callers can display this warning without claiming success. */
export class TernUnsupportedOperationError extends AdapterError {
  constructor(operation: string) {
    super(`Tern ${operation} is unavailable until Tandem's native views are installed`, operation);
    this.name = "TernUnsupportedOperationError";
  }
}

/** Quote numeric identity tokens before JSON.parse can round Tern's u64 ids. */
export function decode<S extends z.ZodType>(raw: string, schema: S, operation: string): z.infer<S> {
  try {
    return schema.parse(
      JSON.parse(raw.replace(/"(id|session|tab|block|pane|Leaf)":\s*(\d+)/gu, '"$1":"$2"')),
    );
  } catch (cause) {
    throw new AdapterProtocolError(operation, String(cause), raw);
  }
}

export type TernOptions = Readonly<{
  binary?: string;
  /** All reads and writes use the same explicit window scope, including absence proofs. */
  windowKey?: string;
  environment?: Readonly<Record<string, string>>;
}>;

export function ternCommands(run: CommandRunner, options: TernOptions) {
  const binary =
    options.binary ??
    Bun.which("tern", { PATH: options.environment?.PATH ?? process.env.PATH ?? "" }) ??
    TERN_BINARY;
  const request = (cwd: string, args: readonly string[]) => ({
    argv: [
      binary,
      ...args,
      ...(options.windowKey === undefined ? [] : ["--window", options.windowKey]),
      "--json",
    ],
    cwd,
    ...(options.environment === undefined ? {} : { env: options.environment }),
  });
  const read = async <S extends z.ZodType>(
    cwd: string,
    args: readonly string[],
    schema: S,
    timeoutMs?: number,
  ): Promise<z.infer<S>> => {
    const req = { ...request(cwd, args), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    const result = await run(req);
    if (result.code !== 0) throw new AdapterCommandError(`tern ${args[0]}`, req, result);
    return decode(result.stdout, schema, `tern ${args[0]}`);
  };
  const mutate = async <S extends z.ZodType>(
    cwd: string,
    args: readonly string[],
    schema: S,
  ): Promise<z.infer<S>> => {
    // Even a failed CLI response can follow a completed daemon effect. Never retry it here.
    try {
      return await read(cwd, args, schema);
    } catch (cause) {
      throw new TernOutcomeUnknownError(`tern ${args[0]}`, cause);
    }
  };
  const ls = async (cwd: string, timeoutMs?: number): Promise<TernListing> => {
    const listing = await read(cwd, ["ls"], Listing, timeoutMs);
    const ids = listing.sessions.flatMap((s) => [
      s.id,
      ...s.tabs.flatMap((t) => [t.id, ...t.blocks.map((b) => b.id)]),
    ]);
    if (new Set(ids).size !== ids.length)
      throw new AdapterProtocolError("tern ls", "duplicate identities", "");
    return listing;
  };
  return { binary, request, read, mutate, ls, run };
}
export type TernCommands = ReturnType<typeof ternCommands>;

export function blocks(listing: TernListing): readonly LocatedBlock[] {
  return listing.sessions.flatMap((session) =>
    session.tabs.flatMap((tab) => tab.blocks.map((block) => ({ session, tab, block }))),
  );
}

export function isDaemonGone(error: unknown): boolean {
  return (
    error instanceof AdapterCommandError &&
    error.result.code !== 0 &&
    error.result.stderr.startsWith("tern ls: no Tern is running (no session daemon on ")
  );
}
