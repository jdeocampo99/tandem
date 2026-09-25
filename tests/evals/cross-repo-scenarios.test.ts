import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { CommandRequest, CommandRunner } from "../../src/contracts.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { writeWorkerReceipt } from "../../src/tasks/communication-persistence.ts";
import { parseWorkerJob, persistWorkerResult } from "../../src/workers/jobs.ts";
import { SCENARIO_NOW, type ScenarioWorld, withScenario } from "./scenario.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", "-C", cwd, ...args], cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Another repository on GitHub: a bare origin whose default branch is `trunk`, and the user's own
 * checkout of it under a Projects folder, on a branch of their own with uncommitted work.
 */
async function otherRepository(world: ScenarioWorld) {
  const root = join(await realpath(join(world.home, "..")), "github");
  const projects = join(root, "Projects");
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const checkout = join(projects, "work", "backend");
  await mkdir(projects, { recursive: true });
  await runCommand({ argv: ["git", "init", "-q", "--bare", "-b", "trunk", origin], cwd: root });
  await runCommand({ argv: ["git", "clone", "-q", origin, author], cwd: root });
  await git(author, "checkout", "-q", "-b", "trunk");
  await writeFile(join(author, "api.ts"), "serve();\n");
  await git(author, "add", "-A");
  await git(author, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "api");
  await git(author, "push", "-q", "origin", "trunk");
  const head = await git(author, "rev-parse", "HEAD");
  await runCommand({ argv: ["git", "clone", "-q", origin, checkout], cwd: root });
  await git(checkout, "remote", "set-url", "origin", "git@github.com:acme/api.git");
  await git(checkout, "checkout", "-q", "-b", "my-work");
  await writeFile(join(checkout, "notes.txt"), "mine\n");
  return { root, projects, origin, checkout, head };
}

/**
 * Real git for the other repository, with its GitHub origin served locally, and pool leases taken
 * from its checkout made into real worktrees of it; the scenario world for everything else.
 */
function composite(world: ScenarioWorld, root: string, origin: string): CommandRunner {
  const leased = new Set<string>();
  return async (request: CommandRequest) => {
    const [program, flag, path] = request.argv;
    if (program === "git" && flag === "-C" && path !== undefined) {
      if (path.startsWith(root) || leased.has(path)) {
        const remote = request.argv.includes("fetch") || request.argv.includes("ls-remote");
        return runCommand({
          ...request,
          argv: remote
            ? request.argv.map((word) => (word === "origin" ? origin : word))
            : request.argv,
        });
      }
    }
    const result = await world.run(request);
    if (program === "treehouse" && request.argv.includes("get") && request.cwd.startsWith(root)) {
      const lease = JSON.parse(result.stdout) as { path: string };
      await rm(lease.path, { recursive: true, force: true });
      await git(request.cwd, "worktree", "add", "-q", "--detach", lease.path);
      leased.add(lease.path);
    }
    return result;
  };
}

function serviceFor(world: ScenarioWorld, run: CommandRunner, projectRoots: readonly string[]) {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run,
    clock: world.clock,
    idFactory: world.idFactory,
    projectRoots,
  });
}

const research = {
  kind: "scout",
  objective: "find how the API serves requests",
  acceptanceCriteria: ["the serving path is described"],
  surfaces: ["api"],
} as const;

test("research in another repository runs from its default branch and leaves the user's checkout alone", async () => {
  await withScenario({}, async (world) => {
    const other = await otherRepository(world);
    const service = serviceFor(world, composite(world, other.root, other.origin), [other.projects]);

    const task = await service.create({
      ...research,
      repoPath: world.repoPath,
      targetRepo: "Acme/API",
    });
    expect(task.repoPath).toBe(world.repoPath);
    expect(task.target).toEqual({ repo: "acme/api", checkout: other.checkout, branch: "trunk" });
    expect((await service.list()).map((entry) => entry.id)).toContain(task.id);

    const runtime = (await world.snapshot()).runtime.tasks.find(
      (entry) => entry.taskId === task.id,
    );
    expect(runtime?.sourceRepoPath).toBe(other.checkout);
    expect(runtime?.sourceCheckpoint.head).toBe(other.head);
    expect(await git(other.checkout, "branch", "--show-current")).toBe("my-work");
    expect(await readFile(join(other.checkout, "notes.txt"), "utf8")).toBe("mine\n");
    await expect(stat(join(other.checkout, ".git", "FETCH_HEAD"))).rejects.toThrow();

    await service.tick();
    const launched = (await world.snapshot()).runtime.tasks.find(
      (entry) => entry.taskId === task.id,
    );
    expect(launched?.worktree?.baseHead).toBe(other.head);
    expect((await service.get(task.id)).stage).toBe("scouting");
    await service.shutdown();
  });
});

test("a repository that is not on disk is asked about, and implementation there asks how to check the work", async () => {
  await withScenario({}, async (world) => {
    const other = await otherRepository(world);
    const service = serviceFor(world, composite(world, other.root, other.origin), [
      join(other.root, "Elsewhere"),
    ]);
    const implementation = {
      ...research,
      kind: "implementation",
      repoPath: world.repoPath,
      targetRepo: "acme/api",
    } as const;

    await expect(service.create(implementation)).rejects.toThrow(
      `Where's acme/api on your machine? Or say "clone it". Ask the user this, then create again with targetCheckout`,
    );
    await expect(
      service.create({ ...implementation, targetCheckout: other.checkout }),
    ).rejects.toThrow("acme/api has no saved validation commands");
    await expect(
      service.create({ ...research, repoPath: world.repoPath, validationCommands: ["bun test"] }),
    ).rejects.toThrow("need targetRepo");

    const task = await service.create({ ...implementation, validationCommands: ["bun test"] });
    expect(task.stage).toBe("awaiting-approval");
    expect(task.policy.config.validationCommands.map((command) => command.argv)).toEqual([
      ["/bin/sh", "-c", "bun test"],
    ]);
    // The answer was remembered, so the next task finds the checkout on its own.
    const again = await service.create({
      ...research,
      repoPath: world.repoPath,
      targetRepo: "acme/api",
    });
    expect(again.target?.checkout).toBe(other.checkout);
    await service.shutdown();
  });
});

test("an implementation in this project never adopts research worktrees from another repository", async () => {
  await withScenario({}, async (world) => {
    const other = await otherRepository(world);
    const service = serviceFor(world, composite(world, other.root, other.origin), [other.projects]);
    const scout = await service.create({
      ...research,
      repoPath: world.repoPath,
      targetRepo: "acme/api",
      researchContinuation: {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "explicit",
      },
    });
    await service.tick();
    const snapshot = await world.snapshot();
    const job = snapshot.runtime.tasks.find((entry) => entry.taskId === scout.id)?.jobs.at(-1);
    if (job === undefined) throw new Error("the research did not launch");
    const spec = parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8")));
    if (spec.communication !== undefined) {
      await writeWorkerReceipt(spec.communication.receiptPath, {
        schemaVersion: 1,
        jobId: job.id,
        taskId: scout.id,
        generation: job.generation,
        receivedRevision: spec.communication.initialRevision,
        appliedRevision: spec.communication.initialRevision,
        heartbeatAt: SCENARIO_NOW,
        progressAt: SCENARIO_NOW,
        phase: "model",
      });
    }
    await persistWorkerResult(job.resultPath, {
      id: job.id,
      taskId: scout.id,
      generation: job.generation,
      role: "scout",
      status: "completed",
      text: "The API serves requests from api.ts.",
      finishedAt: SCENARIO_NOW,
      instructionRevision: spec.communication?.initialRevision ?? 0,
    });
    if (job.endpoint !== undefined) world.replaceForeground(job.endpoint.paneId, ["sh"]);
    await service.tick();
    expect((await service.get(scout.id)).stage).toBe("completed");
    const scoutLease = (await world.snapshot()).runtime.tasks.find(
      (entry) => entry.taskId === scout.id,
    )?.worktree;
    expect(scoutLease).toBeDefined();

    const implementation = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "call the API",
      acceptanceCriteria: ["the client calls the API"],
      surfaces: ["scenario"],
      researchTaskIds: [scout.id],
    });
    await service.approve(implementation.id);
    await service.tick();
    const lease = (await world.snapshot()).runtime.tasks.find(
      (entry) => entry.taskId === implementation.id,
    )?.worktree;
    expect(lease).toBeDefined();
    expect(lease?.leaseId).not.toBe(scoutLease?.leaseId);
    await service.shutdown();
  });
});
