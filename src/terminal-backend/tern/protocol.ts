import { z } from "zod";
import {
  AdapterCommandError,
  AdapterError,
  AdapterProtocolError,
} from "../../adapters/primitives.ts";

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

/** A durable quarantine refused the effect before anything was spawned. */
export class TernQuarantinedError extends TernOutcomeUnknownError {
  constructor(operation: string, cause: unknown) {
    super(operation, cause);
    this.name = "TernQuarantinedError";
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
