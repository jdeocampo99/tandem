import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EndpointOwnershipError } from "../../../src/adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { reconcileTandemResources } from "../../../src/coordinator/reconcile.ts";
import type {
  EndpointInspection,
  TerminalBackend,
} from "../../../src/terminal-backend/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { missing, ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { openFiles, openPath } from "../../native/view-files.ts";

const coordinator: Endpoint = {
  terminal: "tern",
  sessionId: "test",
  terminalSessionId: "1",
  workspaceId: "2",
  tabId: "2",
  paneId: "3",
  role: "coordinator",
  generation: 0,
};

type Owner = "present" | "gone" | "detached";

/** A Tern whose plugin never answers one task open, leaving that open retained. */
async function withRetainedOpen(body: (home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp("/tmp/tandem-native-open-fix-"));
  let now = 0;
  const run: CommandRunner = async (request) => {
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    const verb = request.argv[1];
    if (verb === "inspect") return ok({ clients: [{ kind: "window" }] });
    if (verb === "focus") return ok({ block: "3" });
    if (verb === "open") return { code: 1, stdout: "", stderr: "cannot open in a file block" };
    if (verb === "ls")
      return ok({
        sessions: [
          {
            id: "1",
            name: "fixture",
            tabs: [
              {
                id: "2",
                name: null,
                blocks: [{ id: "3", title: "coordinator", cwd: home, live: true, cols: 150 }],
              },
            ],
          },
        ],
        detached: [],
      });
    throw new Error(`unexpected ${verb}`);
  };
  try {
    await expect(
      ternViewHost(
        ternCli(run, {
          binary: "tern",
          clock: () => now,
          wait: async (ms) => {
            now += ms;
          },
        }),
      ).open(
        { home, cwd: home, coordinator, view: { kind: "task", taskId: "task-new" } },
        home,
        "task",
        "task",
        `${home}/task.json`,
      ),
    ).rejects.toThrow("tern open outcome is unknown");
    await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The configured Tern backend, answering only whether the coordinator pane is there. */
function terminal(owner: () => Owner): TerminalBackend {
  const base = ternBackend(async () => ({ code: 1, stdout: "", stderr: "unexpected" }), {});
  return {
    ...base,
    inspect: async ({ endpoint }) => {
      const state = owner();
      if (state === "gone") throw missing(endpoint);
      if (state === "detached")
        throw new EndpointOwnershipError(
          endpoint,
          "detached Tern blocks leave the pane's placement ambiguous",
        );
      return { endpoint } as unknown as EndpointInspection;
    },
  };
}

const fix = (home: string, owner: () => Owner, apply: boolean) =>
  reconcileTandemResources({
    run: async () => ({ code: 1, stdout: "", stderr: "unexpected" }),
    terminal: terminal(owner),
    home,
    poolRoot: join(home, "pool"),
    repoPaths: [],
    apply,
  });

const intents = async (home: string) =>
  (await openFiles(home)).filter((name) => !name.endsWith(".lock"));

for (const owner of ["present", "gone"] as const) {
  test(`tandem fix lists a retained open and, with --yes, abandons it when its coordinator is ${owner}`, async () => {
    await withRetainedOpen(async (home) => {
      const before = await intents(home);
      expect(before.filter((name) => name.endsWith(".ticket.json"))).toHaveLength(1);
      const planned = await fix(home, () => owner, false);
      expect(planned.cleaned).toEqual([
        expect.objectContaining({
          kind: "native-open",
          sessionId: "test",
          reason: expect.stringContaining("task view: Tern never confirmed the view opened"),
        }),
      ]);
      expect(await intents(home)).toEqual(before);
      const applied = await fix(home, () => owner, true);
      expect(applied.cleaned.map((entry) => entry.kind)).toEqual(["native-open"]);
      expect(await intents(home)).toEqual([]);
    });
  });
}

test("tandem fix keeps a retained open whose coordinator a detached listing hides", async () => {
  await withRetainedOpen(async (home) => {
    const before = await intents(home);
    const applied = await fix(home, () => "detached", true);
    expect(applied.cleaned).toEqual([]);
    expect(applied.retained).toEqual([
      expect.objectContaining({
        kind: "native-open",
        reason: expect.stringContaining("kept because its coordinator cannot be proved"),
      }),
    ]);
    expect(await intents(home)).toEqual(before);
  });
});

test("tandem fix --yes keeps a retained open when the coordinator turns ambiguous before abandon", async () => {
  await withRetainedOpen(async (home) => {
    const before = await intents(home);
    const answers: Owner[] = ["present", "detached"];
    const applied = await fix(home, () => answers.shift() ?? "detached", true);
    expect(applied.retained.map((entry) => entry.kind)).toEqual(["native-open"]);
    expect(await intents(home)).toEqual(before);
  });
});

test("tandem fix reports an unreadable open record and leaves it in place", async () => {
  await withRetainedOpen(async (home) => {
    const [name] = (await intents(home)).filter((each) => each.endsWith(".ticket.json"));
    const path = await openPath(home, name ?? "");
    await Bun.write(path, "{broken");
    const applied = await fix(home, () => "gone", true);
    expect(applied.quarantined).toEqual([expect.objectContaining({ kind: "native-open", path })]);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});

test("tandem fix reports paused views it cannot list and still scans everything else", async () => {
  const home = await realpath(await mkdtemp("/tmp/tandem-native-open-fix-"));
  try {
    await writeFile(join(home, "tern"), "not a directory");
    const planned = await fix(home, () => "present", false);
    expect(planned.failed).toEqual([
      expect.objectContaining({
        kind: "native-open",
        reason: expect.stringContaining("paused views could not be listed"),
      }),
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
