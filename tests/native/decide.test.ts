import { describe, expect, test } from "bun:test";
import { blockArgs, type Receipt, Ticket } from "../../src/native/contract.ts";
import { type Decision, decide, type ViewListing } from "../../src/terminal-backend/tern/host.ts";

const NOW = 1_800_000_000_000;
const index = "/h/native-views/key.json";
const ctx = { coordinator: "3", cwd: "/w", home: "/h", index };
const args = blockArgs("/h/native-views/key/task-t1.json", ctx);

function ticket(extra: Partial<Ticket> = {}): Ticket {
  return Ticket.parse({
    version: 1,
    kind: "task",
    placement: "task",
    args,
    coordinator: "3",
    origin: "3",
    session: "1",
    owner: { sessionId: "s", workspaceId: "2", tabId: "2", generation: 0 },
    receipt: "/h/native-host/k.t.receipt.json",
    ...extra,
  });
}

type Block = Readonly<{ id: string; tab?: string; program?: string; args?: readonly string[] }>;

function listing(blocks: readonly Block[], detached = false): ViewListing {
  const tab = (id: string) => ({
    id,
    name: null,
    blocks: blocks
      .filter((block) => (block.tab ?? "2") === id)
      .map((block) => ({
        id: block.id,
        title: block.program ?? "shell",
        cwd: "/w",
        live: false,
        ...(block.program === undefined ? {} : { program: block.program }),
        ...(block.args === undefined ? {} : { args: [...block.args] }),
      })),
  });
  const value = {
    sessions: [{ id: "1", name: "p", tabs: [tab("2"), tab("4")] }],
    detached: detached ? [{}] : [],
  };
  return { window: value, all: value };
}

const coordinator: Block = { id: "3" };
const opened: Block = { id: "5", program: "tandem.task", args };
const done: Receipt = { status: "done", paneId: "5", tabId: "2", sessionId: "1" };
const failed = (appliedEffects: number): Receipt => ({
  status: "failed",
  stage: "task",
  appliedEffects,
  reason: "Native block could not open",
});
const dispatched = { expiresAt: NOW + 5_000 };
const expired = { expiresAt: NOW };

function answer(decision: Decision): string {
  return decision.action === "settle" ? `settle:${decision.outcome}` : decision.action;
}

const rows: readonly (readonly [
  string,
  Partial<Ticket>,
  Receipt | "torn" | undefined,
  ViewListing | undefined,
  string,
])[] = [
  ["claimed, nothing dispatched", {}, undefined, undefined, "drop"],
  ["claimed, torn receipt", {}, "torn", undefined, "drop"],
  ["dispatched, no receipt, not expired", dispatched, undefined, undefined, "wait"],
  ["dispatched, torn receipt, not expired", dispatched, "torn", undefined, "wait"],
  ["no receipt after expiry", expired, undefined, undefined, "quarantine"],
  ["torn receipt after expiry", expired, "torn", undefined, "quarantine"],
  ["failed before any effect", dispatched, failed(0), undefined, "settle:not-opened"],
  ["failed before any effect, after expiry", expired, failed(0), undefined, "settle:not-opened"],
  ["failed after an effect", dispatched, failed(1), undefined, "quarantine"],
  ["done, one exact match", dispatched, done, listing([coordinator, opened]), "settle:opened"],
  [
    "done after expiry, one exact match",
    expired,
    done,
    listing([coordinator, opened]),
    "settle:opened",
  ],
  [
    "done, zero matches: closed by the user",
    dispatched,
    done,
    listing([coordinator]),
    "settle:closed",
  ],
  ["done, listing unreadable", dispatched, done, undefined, "quarantine"],
  [
    "done, two matches",
    dispatched,
    done,
    listing([coordinator, opened, { ...opened, id: "6" }]),
    "quarantine",
  ],
  [
    "done, the match is another block",
    dispatched,
    done,
    listing([coordinator, { ...opened, id: "6" }]),
    "quarantine",
  ],
  [
    "done, the match is in another tab",
    dispatched,
    done,
    listing([coordinator, { ...opened, tab: "4" }]),
    "quarantine",
  ],
  ["done, detached blocks", dispatched, done, listing([coordinator, opened], true), "quarantine"],
  [
    "done, the replaced task is still present",
    { ...dispatched, replaced: "7" },
    done,
    listing([coordinator, opened, { id: "7", program: "tandem.task" }]),
    "quarantine",
  ],
  [
    "done, the replaced task is gone",
    { ...dispatched, replaced: "7" },
    done,
    listing([coordinator, opened]),
    "settle:opened",
  ],
  [
    "done, a match launched for another window key",
    dispatched,
    { ...done, paneId: "6" },
    listing([
      coordinator,
      { ...opened, id: "6", args: blockArgs(args[0], { ...ctx, window: "other" }) },
    ]),
    "quarantine",
  ],
  [
    "done, the receipt's pane holds another program",
    dispatched,
    done,
    listing([coordinator, { id: "5", program: "unrelated.task", args }]),
    "quarantine",
  ],
  [
    "done, a block for another coordinator is not a match",
    dispatched,
    done,
    listing([
      coordinator,
      { ...opened, id: "6", args: blockArgs(args[0], { ...ctx, coordinator: "9" }) },
    ]),
    "settle:closed",
  ],
  [
    "return done on the coordinator",
    { ...dispatched, kind: "panel", placement: "return" },
    { ...done, paneId: "3" },
    listing([coordinator]),
    "settle:opened",
  ],
  [
    "return done, the coordinator is gone",
    { ...dispatched, kind: "panel", placement: "return" },
    { ...done, paneId: "3" },
    listing([]),
    "settle:closed",
  ],
  [
    "return done on another pane",
    { ...dispatched, kind: "panel", placement: "return" },
    done,
    listing([coordinator, opened]),
    "quarantine",
  ],
  [
    "return done, its closed origin is still present",
    { ...dispatched, kind: "panel", placement: "return", origin: "8", closeOrigin: "8" },
    { ...done, paneId: "3" },
    listing([coordinator, { id: "8", tab: "4", program: "tandem.board" }]),
    "quarantine",
  ],
  [
    "inbox done on its origin",
    { ...dispatched, kind: "panel", placement: "inbox", origin: "8" },
    { ...done, paneId: "8" },
    listing([coordinator, { id: "8", program: "tandem.panel" }]),
    "settle:opened",
  ],
];

describe("decide() follows the staged open state machine", () => {
  for (const [name, extra, receipt, observed, expected] of rows)
    test(name, () => {
      expect(answer(decide(ticket(extra), receipt, observed, NOW))).toBe(expected);
    });
});
