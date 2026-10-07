import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { projectForView } from "../../../src/terminal-backend/tern/views.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("a coordinator reached through a symlinked cwd still owns its views", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-project-for-view-")));
  roots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const worktree = join(root, "pool", "coordinator");
  const link = join(root, "linked-pool");
  await mkdir(repo, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await symlink(join(root, "pool"), link);
  const endpoint = {
    terminal: "tern",
    sessionId: "tandem",
    terminalSessionId: "7",
    workspaceId: "3",
    tabId: "3",
    paneId: "11",
    generation: 0,
    role: "coordinator",
  } as const;
  await saveCoordinatorRecord(home, {
    schemaVersion: 1,
    repoPath: repo,
    endpoint,
    worktree: {
      root: join(root, "pool"),
      path: worktree,
      name: "coordinator",
      baseHead: "abc123",
      branch: "tandem/coordinator",
      leaseId: "lease-11",
      leaseHolder: "coordinator:a",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    harness: DEFAULT_HARNESS,
    command: ["omp"],
  });

  expect(await projectForView(home, endpoint, join(link, "coordinator"))).toBe(repo);
  await expect(projectForView(home, endpoint, repo)).rejects.toThrow(
    "Native view requires exactly one recorded coordinator",
  );
});
