import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockArgs, Receipt, Ticket } from "../../src/native/contract.ts";
import { decide } from "../../src/terminal-backend/tern/host.ts";
import type { TernListing } from "../../src/terminal-backend/tern/protocol.ts";
import { luauBinary } from "../luau.ts";

const NOW_S = 1_800_000_000;
const ROUTE = "/b/tern/0a1b/open/ab12.cd34.ticket.json";
const ctx = { coordinator: "20", cwd: "/b", home: "/b", index: "/b/tern/0a1b/views/index.json" };

function ticket(
  kind: Ticket["kind"],
  placement: Ticket["placement"],
  view: string,
  extra: Partial<Ticket> = {},
): Ticket {
  return Ticket.parse({
    version: 1,
    kind,
    placement,
    args: blockArgs(view, ctx),
    coordinator: "20",
    origin: "20",
    session: "2",
    owner: { sessionId: "s", workspaceId: "21", tabId: "21", generation: 0 },
    receipt: "/b/tern/0a1b/open/ab12.cd34.receipt.json",
    expiresAt: NOW_S * 1000 + 10_000,
    ...extra,
  });
}

/** One TS-built ticket per placement, keyed as the Luau checks look them up. */
const TICKETS: Record<string, Ticket> = {
  "panel/panel": ticket("panel", "panel", ctx.index),
  "catchup/window": ticket("catchup", "window", ctx.index),
  "brief/split": ticket("brief", "split", "/b/tern/0a1b/views/brief-r1.json"),
  "task/task": ticket("task", "task", "/b/tern/0a1b/views/task-t1.json"),
  "task/task-replace": ticket("task", "task", "/b/tern/0a1b/views/task-t2.json", {
    origin: "40",
    replaced: "40",
  }),
  "panel/return": ticket("panel", "return", ctx.index),
  "panel/return-board": ticket("panel", "return", ctx.index, { origin: "30", closeOrigin: "30" }),
  "panel/return-task": ticket("panel", "return", ctx.index, { origin: "40", replaced: "40" }),
  "panel/inbox": ticket("panel", "inbox", ctx.index),
};
const SWEEP = [
  "panel/panel",
  "catchup/window",
  "brief/split",
  "task/task",
  "task/task-replace",
  "panel/return-board",
  "panel/return-task",
  "panel/inbox",
];

function lua(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(",")}}`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`)
      .join(",")}}`;
  throw new TypeError(`cannot pass ${typeof value} to Luau`);
}

const ENCODE = `
local function encode(value)
 if type(value)=="string" then
  return '"' .. string.gsub(string.gsub(string.gsub(value,'\\\\','\\\\\\\\'),'"','\\\\"'),'\\n','\\\\n') .. '"'
 elseif type(value)=="number" then return string.format("%.0f",value)
 elseif type(value)=="boolean" then return tostring(value)
 elseif value==nil then return "null" end
 local parts={}
 if #value>0 or next(value)==nil then
  for _,item in value do table.insert(parts,encode(item)) end
  return "[" .. table.concat(parts,",") .. "]"
 end
 for key,item in value do table.insert(parts,encode(tostring(key)) .. ":" .. encode(item)) end
 return "{" .. table.concat(parts,",") .. "}"
end
`;

type Pane = { id: number; tab: number; block: string; args?: string[] };

/** Tern's listing of the fake window's panes: tab 11 is another project's session. */
function listingOf(panes: readonly Pane[]): TernListing {
  const tab = (id: number) => ({
    id: String(id),
    name: null,
    blocks: panes
      .filter((pane) => pane.tab === id)
      .map((pane) => ({
        id: String(pane.id),
        title: pane.block,
        cwd: "/b",
        live: false,
        ...(pane.block === "shell" ? {} : { program: pane.block }),
        ...(pane.args === undefined ? {} : { args: pane.args }),
      })),
  });
  return {
    sessions: [
      { id: "1", name: "other", tabs: [tab(11)] },
      { id: "2", name: "project", tabs: [tab(21), tab(22)] },
    ],
    detached: [],
  };
}

test("layout.luau runs TS-built tickets, and decide() gives every receipt the table's answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-layout-luau-"));
  try {
    const module = await readFile(
      new URL("../../tern-plugin/layout.luau", import.meta.url),
      "utf8",
    );
    const checks = await readFile(new URL("./layout.luau", import.meta.url), "utf8");
    const path = join(root, "layout.luau");
    await writeFile(
      path,
      [
        `local TICKETS=${lua(TICKETS)}`,
        `local SWEEP=${lua(SWEEP)}`,
        `local NOW_S=${NOW_S}`,
        `local ROUTE=${JSON.stringify(ROUTE)}`,
        "local os={time=function() return NOW_S end}",
        ENCODE,
        `local tern = {}\nlocal host = (function()\n${module}\nend)()\n${checks}`,
      ].join("\n"),
    );
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr + stdout).toBe(0);
    expect(stdout).toContain(
      "Staged layout, second-project views, fresh contexts, expiry and quarantine checks passed",
    );
    const runs = stdout
      .split("\n")
      .filter((line) => line.startsWith("T4\t"))
      .map((line) => {
        const [, name = "", stage = "", receipt = "", panes = "", changed = ""] = line.split("\t");
        return {
          name,
          stage: Number(stage),
          receipt: JSON.parse(receipt),
          panes: JSON.parse(panes),
          changed: changed === "true",
        };
      });
    expect(new Set(runs.map((run) => run.name))).toEqual(new Set(SWEEP));
    const answers: string[] = [];
    for (const run of runs) {
      const issued = TICKETS[run.name];
      if (issued === undefined) throw new Error(`unknown ticket ${run.name}`);
      const receipt = Receipt.parse(run.receipt);
      const listing = listingOf(run.panes);
      const decision = decide(issued, receipt, { window: listing, all: listing }, NOW_S * 1000);
      const answer = decision.action === "settle" ? `settle:${decision.outcome}` : decision.action;
      if (run.stage === 0)
        expect(`${run.name} clean ${answer}`).toBe(`${run.name} clean settle:opened`);
      if (receipt.status === "done") expect(answer).toBe("settle:opened");
      // A failure that left the layout changed must count that effect, or decide() would settle
      // a changed layout as never opened.
      else if (run.changed)
        expect(`${run.name}@${run.stage} ${answer}`).toBe(`${run.name}@${run.stage} quarantine`);
      else
        expect(`${run.name}@${run.stage} ${answer}`).toBe(
          `${run.name}@${run.stage} ${receipt.appliedEffects === 0 ? "settle:not-opened" : "quarantine"}`,
        );
      answers.push(answer);
    }
    // The sweep reaches both failure answers, not only clean opens.
    expect(answers).toContain("settle:not-opened");
    expect(answers).toContain("quarantine");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
