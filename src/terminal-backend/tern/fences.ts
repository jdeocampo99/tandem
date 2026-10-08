import type {
  Fence,
  FenceKind,
  FenceListingFailure,
  FenceProof,
  FenceSettlement,
  FencesCapability,
  ReadableFence,
  TerminalBackend,
} from "../contract.ts";
import { clearTernQuarantine, listTernQuarantine } from "./quarantine.ts";

/** How Tern proves a fence's pane: the backend's own exact inspection and gone test. */
export type FenceProver = Pick<TerminalBackend, "inspect" | "isEndpointGone">;

/** One Tern ledger of unknown-outcome effects, listed and settled under its own records' locks. */
type Ledger = Readonly<{
  kind: FenceKind;
  /** What could not be listed, and the reason's lead, when the whole ledger is unreadable. */
  subject: string;
  unlisted: string;
  unreadable: string;
  changed: string;
  unproven: string;
  read(home: string): Promise<readonly FenceRecord[]>;
  proof(state: PaneState): FenceProof;
  clear(
    record: Readonly<{ path: string; record: string }>,
    conclusive: () => Promise<boolean>,
  ): Promise<"abandoned" | "cleared" | "settled" | "changed" | "unproven">;
}>;

type FenceRecord =
  | Readonly<{ status: "unreadable"; path: string; reason: string }>
  | Readonly<{
      status: "readable";
      path: string;
      record: string;
      protects: ReadableFence["protects"];
      description: string;
    }>;

/** A pane read exactly: present (busy or idle), gone, or something the terminal cannot answer. */
type PaneState =
  | Readonly<{ status: "present"; busy: boolean }>
  | Readonly<{ status: "gone" }>
  | Readonly<{ status: "ambiguous"; detail: string }>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Anything the terminal cannot answer exactly, including a detached listing, is ambiguous. */
async function paneState(
  prover: FenceProver,
  protects: ReadableFence["protects"],
): Promise<PaneState> {
  try {
    const inspected = await prover.inspect(protects);
    return { status: "present", busy: inspected.activeWorker };
  } catch (error) {
    return prover.isEndpointGone(error)
      ? { status: "gone" }
      : { status: "ambiguous", detail: describeFailure(error) };
  }
}

/** A retained open goes once its coordinator is exactly present or exactly gone. */
function openProof(state: PaneState): FenceProof {
  if (state.status === "present")
    return {
      settleable: true,
      why: "new Tandem views stay paused for its running coordinator until the record is abandoned; every pane is kept",
    };
  if (state.status === "gone")
    return { settleable: true, why: "its coordinator is gone, so the record can be removed" };
  return {
    settleable: false,
    why: `kept because its coordinator cannot be proved: ${state.detail}`,
  };
}

/** A pane quarantine goes once its pane is gone or idle at its exact id. */
function paneProof(state: PaneState): FenceProof {
  if (state.status === "gone")
    return { settleable: true, why: "the pane is gone, so the record can be removed" };
  if (state.status === "present" && !state.busy)
    return {
      settleable: true,
      why: "the pane is idle at its exact id, so the record can be removed; the pane is kept",
    };
  if (state.status === "present")
    return { settleable: false, why: "kept because the pane is still running something" };
  return { settleable: false, why: `kept because the pane cannot be proved: ${state.detail}` };
}

const ledgers: readonly Ledger[] = [
  {
    kind: "native-open",
    subject: "native view opens",
    unlisted: "paused views could not be listed",
    unreadable: "the paused Tern view record could not be read and is left in place",
    changed: "the paused view record changed while fix ran, so it was kept",
    unproven: "kept because its coordinator cannot be proved",
    proof: openProof,
    read: async (home) => {
      // Loaded on use to keep native hosting out of every backend load.
      const { listRetainedNativeOpens } = await import("./host.ts");
      return (await listRetainedNativeOpens(home)).map(
        (open): FenceRecord =>
          open.status === "unreadable"
            ? open
            : {
                status: "readable",
                path: open.path,
                record: open.record,
                protects: { endpoint: open.coordinator, cwd: open.cwd },
                description: `${open.view} view: ${open.reason}`,
              },
      );
    },
    clear: async (record, conclusive) =>
      (await import("./host.ts")).abandonRetainedNativeOpen(record, conclusive),
  },
  {
    kind: "tern-quarantine",
    subject: "quarantined panes",
    unlisted: "quarantined panes could not be listed",
    unreadable: "the Tern pane quarantine record could not be read and is left in place",
    changed: "the pane quarantine record changed while fix ran, so it was kept",
    unproven: "kept because the pane is not proven gone or idle",
    proof: paneProof,
    read: async (home) =>
      (await listTernQuarantine(home)).map(
        (pane): FenceRecord =>
          pane.status === "unreadable"
            ? pane
            : {
                status: "readable",
                path: pane.path,
                record: pane.record,
                protects: { endpoint: pane.endpoint, cwd: pane.cwd },
                description: `${pane.operation} on ${pane.key} at ${pane.at} has an unknown outcome (${pane.reason})`,
              },
      ),
    clear: clearTernQuarantine,
  },
];

async function listFences(ledger: Ledger, prover: FenceProver, home: string): Promise<Fence[]> {
  const fences: Fence[] = [];
  for (const record of await ledger.read(home)) {
    if (record.status === "unreadable") {
      fences.push({
        ...record,
        kind: ledger.kind,
        reason: `${ledger.unreadable}: ${record.reason}`,
      });
    } else {
      fences.push({
        status: "readable",
        kind: ledger.kind,
        path: record.path,
        token: record.record,
        protects: record.protects,
        description: record.description,
        proof: ledger.proof(await paneState(prover, record.protects)),
      });
    }
  }
  return fences;
}

async function settleFence(
  ledger: Ledger,
  prover: FenceProver,
  fence: ReadableFence,
): Promise<FenceSettlement> {
  let doubt = "";
  const outcome = await ledger.clear({ path: fence.path, record: fence.token }, async () => {
    const state = await paneState(prover, fence.protects);
    if (state.status === "ambiguous") doubt = state.detail;
    if (state.status === "present" && state.busy) doubt = "the pane is running something";
    return ledger.proof(state).settleable;
  });
  if (outcome === "changed") return { status: "kept", reason: ledger.changed };
  if (outcome === "unproven") return { status: "kept", reason: `${ledger.unproven}: ${doubt}` };
  return { status: "removed" };
}

/**
 * Tern's fences: retained native opens and pane quarantine records. A ledger that cannot be
 * listed is reported as a failure of its kind, and the other is still listed.
 */
export function ternFences(prover: FenceProver): FencesCapability {
  return {
    list: async (home) => {
      const fences: Fence[] = [];
      const failures: FenceListingFailure[] = [];
      for (const ledger of ledgers) {
        try {
          fences.push(...(await listFences(ledger, prover, home)));
        } catch (error) {
          failures.push({
            kind: ledger.kind,
            subject: ledger.subject,
            reason: `${ledger.unlisted}: ${describeFailure(error)}`,
          });
        }
      }
      return { fences, failures };
    },
    settle: async (fence) => {
      const ledger = ledgers.find((each) => each.kind === fence.kind);
      if (ledger === undefined)
        return { status: "kept", reason: `Tern keeps no ${fence.kind} records to settle` };
      return settleFence(ledger, prover, fence);
    },
  };
}
