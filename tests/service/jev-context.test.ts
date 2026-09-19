import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../src/contracts.ts";
import { collectJevContextCandidates, JEV_CONTEXT_LIMITS } from "../../src/service/jev-context.ts";

function task(
  id: string,
  repoPath: string,
  surfaces: readonly string[] = [],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    repoPath,
    kind: "implementation",
    objective: "implement the requested behavior",
    acceptanceCriteria: ["preserve safety"],
    surfaces,
    stage: "queued",
    scopeApproved: true,
    generation: 1,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    ...overrides,
  } as TaskRecord;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tandem-jev-context-"));
  const home = join(root, "home");
  const worktree = join(root, "worktree");
  await mkdir(home, { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  return { root, home, worktree };
}

test("collects same-project completed scout reports and explicit code surfaces deterministically", async () => {
  const paths = await fixture();
  try {
    const report = join(paths.home, "jobs", "scout-1", "report.txt");
    await mkdir(join(paths.home, "jobs", "scout-1"), { recursive: true });
    await writeFile(report, "Research found the existing dispatch boundary.\n");
    const misplacedReport = join(paths.home, "jobs", "other-task", "report.txt");
    await mkdir(join(paths.home, "jobs", "other-task"), { recursive: true });
    await writeFile(misplacedReport, "must not be treated as scout-1 evidence\n");
    await writeFile(join(paths.worktree, "src", "feature.ts"), "export const feature = true;\n");

    const target = task("target", paths.worktree, ["src/feature.ts", "the dispatch boundary"]);
    const completedScout = task("scout-1", paths.worktree, [], {
      kind: "scout",
      stage: "completed",
      reportPath: report,
    });
    const unrelatedScout = task("foreign", join(paths.root, "other-project"), [], {
      kind: "scout",
      stage: "completed",
      reportPath: report,
    });
    const pendingScout = task("pending", paths.worktree, [], {
      kind: "scout",
      stage: "scouting",
      reportPath: report,
    });
    const misplacedScout = task("scout-2", paths.worktree, [], {
      kind: "scout",
      stage: "completed",
      reportPath: misplacedReport,
    });

    const input = {
      task: target,
      tasks: [pendingScout, unrelatedScout, misplacedScout, completedScout],
      home: paths.home,
      worktreePath: paths.worktree,
    };
    const first = await collectJevContextCandidates(input);
    const second = await collectJevContextCandidates(input);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]?.source).toBe("scout report scout-1");
    expect(first[0]?.excerpt).toContain("existing dispatch boundary");
    expect(first[1]?.source).toBe("surface src/feature.ts");
    expect(first[1]?.excerpt).toContain("feature = true");
    expect(first.every((candidate) => candidate.id.startsWith("jev-"))).toBe(true);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("does not read traversal, symlink, secret, binary, or prose surfaces", async () => {
  const paths = await fixture();
  const outside = join(paths.root, "outside.txt");
  try {
    await writeFile(outside, "must not be read");
    await writeFile(join(paths.worktree, "src", "safe.ts"), "export const safe = 1;\n");
    await writeFile(join(paths.worktree, ".env"), "TYPESAFE_API_KEY=must-not-read\n");
    await writeFile(join(paths.worktree, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));
    await mkdir(join(paths.worktree, "config"), { recursive: true });
    await writeFile(join(paths.worktree, "config", "credentials.json"), '{"token":"secret"}');
    await symlink(outside, join(paths.worktree, "src", "linked.ts"));

    const target = task("target", paths.worktree, [
      "src/safe.ts",
      "../outside.txt",
      "src/linked.ts",
      "src/binary.ts",
      "config/credentials.json",
      ".env",
      "this is task prose, not a path",
    ]);
    const candidates = await collectJevContextCandidates({
      task: target,
      tasks: [],
      home: paths.home,
      worktreePath: paths.worktree,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("surface src/safe.ts");
    expect(candidates[0]?.excerpt).not.toContain("must not be read");
    expect(candidates[0]?.excerpt).not.toContain("TYPESAFE_API_KEY");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("keeps optional evidence bounded and ignores unreadable candidates", async () => {
  const paths = await fixture();
  try {
    const reportDirectory = join(paths.home, "jobs", "scout-1");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, "report.txt"), "r".repeat(10_000));
    await writeFile(join(paths.worktree, "src", "large.ts"), "s".repeat(10_000));
    const target = task("target", paths.worktree, ["src/large.ts", "src/missing.ts"], {
      kind: "implementation",
    });
    const scout = task("scout-1", paths.worktree, [], {
      kind: "scout",
      stage: "completed",
      reportPath: join(reportDirectory, "report.txt"),
    });

    const candidates = await collectJevContextCandidates({
      task: target,
      tasks: [scout],
      home: paths.home,
      worktreePath: paths.worktree,
    });
    const totalBytes = candidates.reduce(
      (total, candidate) => total + Buffer.byteLength(candidate.excerpt, "utf8"),
      0,
    );

    expect(candidates.length).toBeLessThanOrEqual(JEV_CONTEXT_LIMITS.maxCandidates);
    expect(totalBytes).toBeLessThanOrEqual(JEV_CONTEXT_LIMITS.maxTotalBytes);
    expect(
      candidates.every(
        (candidate) =>
          Buffer.byteLength(candidate.excerpt, "utf8") <= JEV_CONTEXT_LIMITS.maxExcerptBytes,
      ),
    ).toBe(true);
    expect(candidates).toHaveLength(2);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
