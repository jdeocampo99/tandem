import { expect, test } from "bun:test";
import type { ReconcileReport, ReconcileReportEntry } from "../../src/coordinator/reconcile.ts";
import {
  type FixDetails,
  type FixTaskDetail,
  fixCleanupCount,
  NO_FIX_DETAILS,
  renderFixReport,
  renderFixReportVerbose,
  renderRenest,
  taskTitle,
} from "../../src/terminal/fix-report.ts";

const REPO = "/work/tagalog-learning-app";
const POOL = "/home/pool/.treehouse/tagalog-learning-app-db7caf";
const HOME = "/home/.tandem";
const REGISTRY = `${HOME}/coordinator-registry/abc/def.json`;
const NOTE = `${HOME}/coordinator-quarantine/e0ae1e60.json`;

const CANCELLED = "the cancelled implementation task still holds child resources";

function task(id: string, detail: Omit<FixTaskDetail, "worktreePath">, slot: number) {
  return [id, { ...detail, worktreePath: `${POOL}/${slot}/tagalog-learning-app` }] as const;
}

const details: FixDetails = {
  tasks: new Map([
    task("40e690d8-0000", { title: "TAG-1036", kind: "implementation", stage: "cancelled" }, 3),
    task("36a4f150-0000", { title: "TAG-1036", kind: "implementation", stage: "cancelled" }, 4),
    task("e2c0fbb5-0000", { title: "TAG-1036", kind: "implementation", stage: "ready" }, 5),
    task("dcd45360-0000", { title: "TAG-1036 research", kind: "scout", stage: "completed" }, 2),
  ]),
  leaseTasks: new Map([
    ["lease-2", "dcd45360-0000"],
    ["lease-3", "40e690d8-0000"],
    ["lease-4", "36a4f150-0000"],
    ["lease-5", "e2c0fbb5-0000"],
  ]),
};

function lease(slot: number): ReconcileReportEntry {
  return {
    kind: "worktree-lease",
    id: `lease-${slot}`,
    reason: "the lease is held by a task, which is not a Tandem coordinator",
    repoPath: REPO,
    path: `${POOL}/${slot}/tagalog-learning-app`,
  };
}

const implementation = (id: string): ReconcileReportEntry => ({
  kind: "implementation-task",
  id,
  reason: CANCELLED,
  repoPath: REPO,
});

const coordinator: ReconcileReportEntry = {
  kind: "coordinator",
  id: REGISTRY,
  reason: 'a coordinator is running in Herdr session "tandem" (pane "w1D:p1")',
  repoPath: REPO,
  sessionId: "tandem",
  path: REGISTRY,
};

const note: ReconcileReportEntry = {
  kind: "quarantine-note",
  id: NOTE,
  reason: "the lease this note kept track of has since been returned, so the note can be removed",
  repoPath: REPO,
  sessionId: "tandem",
  path: NOTE,
};

function report(overrides: Partial<ReconcileReport>): ReconcileReport {
  return {
    schemaVersion: 3,
    mode: "dry-run",
    home: HOME,
    cleaned: [],
    retained: [],
    quarantined: [],
    failed: [],
    freeable: [],
    ...overrides,
  };
}

const dryRun = report({
  cleaned: [implementation("40e690d8-0000"), implementation("36a4f150-0000"), note],
  retained: [coordinator, lease(2), lease(3), lease(4), lease(5)],
});

test("a task and the worktree it holds share one line, and other things get one line each", () => {
  expect(renderFixReport(dryRun, details)).toBe(
    [
      "Tandem fix · nothing changed yet",
      "",
      "Clean up (3)",
      "  TAG-1036 · cancelled attempt         40e690d8   worktree 3",
      "  TAG-1036 · cancelled attempt         36a4f150   worktree 4",
      "  Old note about a returned worktree",
      "",
      "Keep (3)",
      "  Coordinator · tagalog-learning-app   running",
      "  TAG-1036 research · done             dcd45360   worktree 2",
      "  TAG-1036 · ready to publish          e2c0fbb5   worktree 5",
      "",
      "tandem fix --verbose shows paths and reasons",
      "",
    ].join("\n"),
  );
  expect(fixCleanupCount(dryRun, details)).toBe(3);
});

test("a paused Tern view open gets one line, with its reason while it is kept", () => {
  const open = {
    kind: "native-open" as const,
    id: "/home/native-host/a.intent.json",
    path: "/home/native-host/a.intent.json",
    sessionId: "s1",
  };
  const shown = report({
    cleaned: [{ ...open, reason: "task view: Tern never confirmed the view opened; ..." }],
    retained: [
      {
        ...open,
        id: "/home/native-host/b.intent.json",
        reason: "kept because its coordinator cannot be proved",
      },
    ],
  });
  expect(renderFixReport(shown, details)).toBe(
    [
      "Tandem fix · nothing changed yet",
      "",
      "Clean up (1)",
      "  Paused Tern view   unproven open record · panes kept",
      "",
      "Keep (1)",
      "  Paused Tern view   kept because its coordinator cannot be proved",
      "",
      "tandem fix --verbose shows paths and reasons",
      "",
    ].join("\n"),
  );
});

test("worktrees whose work is elsewhere get their own section, and kept ones say why", () => {
  const offered = report({
    cleaned: [
      {
        ...implementation("40e690d8-0000"),
        worktreeStays: "has commits not in main or any other work",
      },
      note,
    ],
    retained: [coordinator, lease(2), lease(3), lease(4), lease(5)],
    freeable: [{ ...implementation("36a4f150-0000"), containedIn: "task e2c0fbb5" }],
  });
  expect(renderFixReport(offered, details)).toBe(
    [
      "Tandem fix · nothing changed yet",
      "",
      "Clean up (2)",
      "  TAG-1036 · cancelled attempt         40e690d8   worktree 3   stays: has commits not in main or any other work",
      "  Old note about a returned worktree",
      "",
      "Can also free (1)",
      "  TAG-1036 · cancelled attempt         36a4f150   worktree 4   work is in task e2c0fbb5",
      "",
      "Keep (3)",
      "  Coordinator · tagalog-learning-app   running",
      "  TAG-1036 research · done             dcd45360   worktree 2",
      "  TAG-1036 · ready to publish          e2c0fbb5   worktree 5",
      "",
      "Freeing returns a worktree but keeps its branch, so no commit is lost.",
      "tandem fix --verbose shows paths and reasons",
      "",
    ].join("\n"),
  );
  expect(fixCleanupCount(offered, details)).toBe(2);

  const freed = renderFixReport(
    report({
      mode: "applied",
      cleaned: [{ ...implementation("36a4f150-0000"), containedIn: "task e2c0fbb5" }],
    }),
    details,
  );
  expect(freed).toContain("36a4f150   worktree 4   freed · work is in task e2c0fbb5\n");
  expect(freed).toContain("Freed worktrees keep their branches, so no commit is lost.");

  const declined = renderFixReport(
    report({ mode: "applied", freeable: offered.freeable }),
    details,
  );
  expect(declined).toContain("Can also free (1)");
  expect(declined).toContain("To free them: tandem fix --yes --free-superseded");
  expect(renderFixReportVerbose(offered)).toContain("(commits are in task e2c0fbb5)");
  const onlyMain = renderFixReport(
    report({ freeable: [{ ...implementation("36a4f150-0000"), containedIn: "main" }] }),
    details,
  );
  expect(onlyMain).toContain("36a4f150   worktree 4   only main's commits\n");
});

test("after applying, a task whose cleanup did not finish is kept and says so", () => {
  const applied = report({
    mode: "applied",
    cleaned: [implementation("40e690d8-0000"), note],
    retained: [implementation("36a4f150-0000"), coordinator, lease(3), lease(4)],
  });
  const text = renderFixReport(applied, details);
  expect(text).toContain("Tandem fix · done\n\nCleaned (2)\n");
  expect(text).toContain("Kept (2)\n");
  expect(text).toMatch(/Kept \(2\)\n {2}TAG-1036 · cancelled attempt +36a4f150 +worktree 4\n/u);
  expect(text).toContain("Some task cleanups did not finish, so their worktrees stay.");
  expect(text).not.toContain("worktree 3\n  TAG");
});

test("things Tandem refused to touch keep a one-line reason", () => {
  const text = renderFixReport(
    report({
      quarantined: [
        {
          kind: "unreadable-record",
          id: REGISTRY,
          reason: "the stored coordinator record could not be read and is left in place",
          path: REGISTRY,
        },
      ],
    }),
    NO_FIX_DETAILS,
  );
  expect(text).toContain(
    "Left alone (1)\n  Unreadable coordinator record   the stored coordinator",
  );
});

test("nothing to clean is one line, and the verbose view keeps paths and reasons", () => {
  expect(renderFixReport(report({ retained: [coordinator] }), details)).toBe(
    "Tandem fix · nothing to clean up\n",
  );
  const verbose = renderFixReportVerbose(dryRun);
  expect(verbose).toContain(`Tandem checked ${HOME} and changed nothing yet.`);
  expect(verbose).toContain(`  - quarantine-note ${NOTE}: the lease this note kept track of`);
  expect(verbose).toContain(`  - worktree-lease lease-3 (${POOL}/3/tagalog-learning-app): `);
  expect(verbose).toContain(`implementation-task 40e690d8-0000 (${REPO}): ${CANCELLED}`);
});

test("a task is named by its ticket key or a shortened objective", () => {
  expect(taskTitle("implementation", "Fix TAG-1036: lesson audio stalls")).toBe("TAG-1036");
  expect(taskTitle("scout", "Look into TAG-7 flakiness")).toBe("TAG-7 research");
  expect(taskTitle("implementation", "Make the settings page load faster on slow phones")).toBe(
    "Make the settings page load fas…",
  );
});

test("a Tandem-labelled workspace no task owns is reported as kept, never cleaned", () => {
  expect(
    renderRenest(
      {
        planned: [],
        moved: 0,
        warnings: [],
        leftovers: [
          {
            workspaceId: "w1F",
            label: "└ implement Execute TAG-1036 Chapter 7 produ… · 9c1d9272e688",
          },
        ],
      },
      NO_FIX_DETAILS,
    ),
  ).toBe(
    "Leftover workspace · TAG-1036 · w1F   kept: no task owns it any more; close it in Herdr if it is done\n",
  );
});
