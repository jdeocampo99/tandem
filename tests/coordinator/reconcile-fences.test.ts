import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint } from "../../src/contracts.ts";
import { reconcileTandemResources } from "../../src/coordinator/reconcile.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type {
  Fence,
  FenceListing,
  FenceSettlement,
  ReadableFence,
} from "../../src/terminal-backend/contract.ts";

const pane: Endpoint = {
  terminal: "tern",
  sessionId: "session-a",
  terminalSessionId: "1",
  workspaceId: "2",
  tabId: "2",
  paneId: "3",
  role: "implementer",
  generation: 0,
};

const readable = (path: string, settleable: boolean): ReadableFence => ({
  status: "readable",
  kind: "tern-quarantine",
  path,
  token: `{"path":"${path}"}`,
  protects: { endpoint: pane, cwd: "/repo" },
  description: `doubted effect at ${path}`,
  proof: { settleable, why: settleable ? "it can go" : "kept because it cannot" },
});

const unreadable: Fence = {
  status: "unreadable",
  kind: "native-open",
  path: "/fences/broken",
  reason: "the record could not be read and is left in place: bad JSON",
};

/** A terminal whose fences are exactly `listing`, recording every settle it is asked for. */
async function withFences(
  listing: FenceListing,
  settle: (fence: ReadableFence) => Promise<FenceSettlement>,
  body: (fix: (apply: boolean) => ReturnType<typeof reconcileTandemResources>) => Promise<void>,
): Promise<void> {
  const home = await realpath(await mkdtemp("/tmp/tandem-reconcile-fences-"));
  const unexpected = async () => ({ code: 1, stdout: "", stderr: "unexpected" });
  const terminal = {
    ...terminalBackend(unexpected, { terminal: "herdr", home }),
    fences: { list: async () => listing, settle },
  };
  try {
    await body((apply) =>
      reconcileTandemResources({
        run: unexpected,
        terminal,
        home,
        poolRoot: join(home, "pool"),
        repoPaths: [],
        apply,
      }),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the dry run plans every fence from its one shape and settles none", async () => {
  const settled: ReadableFence[] = [];
  await withFences(
    {
      fences: [readable("/fences/a", true), readable("/fences/b", false), unreadable],
      failures: [{ kind: "native-open", subject: "native view opens", reason: "unlistable" }],
    },
    async (fence) => {
      settled.push(fence);
      return { status: "removed" };
    },
    async (fix) => {
      const report = await fix(false);
      expect(report.cleaned).toEqual([
        {
          kind: "tern-quarantine",
          id: "/fences/a",
          path: "/fences/a",
          sessionId: "session-a",
          reason: "doubted effect at /fences/a; it can go",
        },
      ]);
      expect(report.retained).toEqual([
        expect.objectContaining({
          kind: "tern-quarantine",
          path: "/fences/b",
          reason: "doubted effect at /fences/b; kept because it cannot",
        }),
      ]);
      expect(report.quarantined).toEqual([
        {
          kind: "native-open",
          id: "/fences/broken",
          path: "/fences/broken",
          reason: unreadable.reason,
        },
      ]);
      expect(report.failed).toEqual([
        { kind: "native-open", id: "native view opens", reason: "unlistable" },
      ]);
      expect(settled).toEqual([]);
    },
  );
});

test("applying settles only a settleable fence, exactly as listed, and keeps what its terminal keeps", async () => {
  const settled: ReadableFence[] = [];
  const answers: FenceSettlement[] = [
    { status: "removed" },
    { status: "kept", reason: "the record changed while fix ran, so it was kept" },
  ];
  const fences = [readable("/fences/a", true), readable("/fences/b", true)];
  await withFences(
    { fences: [...fences, readable("/fences/c", false), unreadable], failures: [] },
    async (fence) => {
      settled.push(fence);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("the terminal could not settle it");
      return answer;
    },
    async (fix) => {
      const report = await fix(true);
      expect(settled).toEqual(fences);
      expect(report.cleaned.map((entry) => [entry.path, entry.reason])).toEqual([
        ["/fences/a", "doubted effect at /fences/a; it can go"],
      ]);
      expect(report.retained.map((entry) => [entry.path, entry.reason])).toEqual([
        ["/fences/b", "the record changed while fix ran, so it was kept"],
        ["/fences/c", "doubted effect at /fences/c; kept because it cannot"],
      ]);
      expect(report.quarantined.map((entry) => entry.path)).toEqual(["/fences/broken"]);
    },
  );
});

test("a fence its terminal fails to settle is reported failed and the rest still settle", async () => {
  const settled: string[] = [];
  await withFences(
    { fences: [readable("/fences/a", true), readable("/fences/b", true)], failures: [] },
    async (fence) => {
      settled.push(fence.path);
      if (fence.path === "/fences/a") throw new Error("lock timed out");
      return { status: "removed" };
    },
    async (fix) => {
      const report = await fix(true);
      expect(settled).toEqual(["/fences/a", "/fences/b"]);
      expect(report.failed).toEqual([
        expect.objectContaining({ path: "/fences/a", reason: "lock timed out" }),
      ]);
      expect(report.cleaned.map((entry) => entry.path)).toEqual(["/fences/b"]);
    },
  );
});
