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
import { clearTernQuarantine, listTernQuarantine } from "./cli.ts";

/** How Tern proves a fence's pane: the backend's own exact inspection and gone test. */
export type FenceProver = Pick<TerminalBackend, "inspect" | "isEndpointGone">;

/** One Tern ledger of unknown-outcome effects, listed and settled under its own records' locks. */
type Ledger = Readonly<{
  kind: FenceKind;
  /** What could not be listed, and the reason's lead, when the whole ledger is unreadable. */
  subject: string;
  unlisted: string;
  list(home: string): Promise<readonly Fence[]>;
  settle(fence: ReadableFence): Promise<FenceSettlement>;
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

/** Staged native view opens, under `<home>/tern/<projectKey>/open/`. */
function nativeOpens(prover: FenceProver): Ledger {
  // Loaded on use, as native hosting is, to keep it out of every backend load.
  const host = () => import("./host.ts");
  return {
    kind: "native-open",
    subject: "native view opens",
    unlisted: "paused views could not be listed",
    list: async (home) => {
      const fences: Fence[] = [];
      for (const open of await (await host()).listRetainedNativeOpens(home)) {
        if (open.status === "unreadable") {
          fences.push({
            status: "unreadable",
            kind: "native-open",
            path: open.path,
            reason: `the paused Tern view record could not be read and is left in place: ${open.reason}`,
          });
          continue;
        }
        const protects = { endpoint: open.coordinator, cwd: open.cwd };
        fences.push({
          status: "readable",
          kind: "native-open",
          path: open.path,
          token: open.record,
          protects,
          description: `${open.view} view: ${open.reason}`,
          proof: openProof(await paneState(prover, protects)),
        });
      }
      return fences;
    },
    settle: async (fence) => {
      let doubt = "";
      const outcome = await (await host()).abandonRetainedNativeOpen(
        { path: fence.path, record: fence.token },
        async () => {
          const state = await paneState(prover, fence.protects);
          if (state.status === "ambiguous") doubt = state.detail;
          return state.status !== "ambiguous";
        },
      );
      if (outcome === "abandoned" || outcome === "settled") return { status: "removed" };
      return {
        status: "kept",
        reason:
          outcome === "changed"
            ? "the paused view record changed while fix ran, so it was kept"
            : `kept because its coordinator cannot be proved: ${doubt}`,
      };
    },
  };
}

/** Pane quarantine records, under `<home>/tern-quarantine/`. */
function quarantinedPanes(prover: FenceProver): Ledger {
  return {
    kind: "tern-quarantine",
    subject: "quarantined panes",
    unlisted: "quarantined panes could not be listed",
    list: async (home) => {
      const fences: Fence[] = [];
      for (const pane of await listTernQuarantine(home)) {
        if (pane.status === "unreadable") {
          fences.push({
            status: "unreadable",
            kind: "tern-quarantine",
            path: pane.path,
            reason: `the Tern pane quarantine record could not be read and is left in place: ${pane.reason}`,
          });
          continue;
        }
        const protects = { endpoint: pane.endpoint, cwd: pane.cwd };
        fences.push({
          status: "readable",
          kind: "tern-quarantine",
          path: pane.path,
          token: pane.record,
          protects,
          description: `${pane.operation} on ${pane.key} at ${pane.at} has an unknown outcome (${pane.reason})`,
          proof: paneProof(await paneState(prover, protects)),
        });
      }
      return fences;
    },
    settle: async (fence) => {
      let doubt = "";
      const outcome = await clearTernQuarantine(
        { path: fence.path, record: fence.token },
        async () => {
          const state = await paneState(prover, fence.protects);
          if (state.status === "ambiguous") doubt = state.detail;
          if (state.status === "present" && state.busy) doubt = "the pane is running something";
          return state.status === "gone" || (state.status === "present" && !state.busy);
        },
      );
      if (outcome === "cleared" || outcome === "settled") return { status: "removed" };
      return {
        status: "kept",
        reason:
          outcome === "changed"
            ? "the pane quarantine record changed while fix ran, so it was kept"
            : `kept because the pane is not proven gone or idle: ${doubt}`,
      };
    },
  };
}

/**
 * Tern's fences: retained native opens and pane quarantine records. A ledger that cannot be
 * listed is reported as a failure of its kind, and the other is still listed.
 */
export function ternFences(prover: FenceProver): FencesCapability {
  const ledgers = [nativeOpens(prover), quarantinedPanes(prover)];
  return {
    list: async (home) => {
      const fences: Fence[] = [];
      const failures: FenceListingFailure[] = [];
      for (const ledger of ledgers) {
        try {
          fences.push(...(await ledger.list(home)));
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
      return ledger.settle(fence);
    },
  };
}
