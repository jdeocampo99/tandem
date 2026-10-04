import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  TaskRecord,
} from "../../src/contracts.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { writeWorkerReceipt } from "../../src/tasks/communication-persistence.ts";
import { parseWorkerJob, persistWorkerResult } from "../../src/workers/jobs.ts";
import { SCENARIO_NOW, type ScenarioWorld, withScenario } from "./scenario.ts";

const URL = "https://github.com/acme/api/pull/7";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", "-C", cwd, ...args], cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(repo: string, file: string, text: string): Promise<string> {
  await mkdir(join(repo, file, ".."), { recursive: true });
  await writeFile(join(repo, file), text);
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file);
  return git(repo, "rev-parse", "HEAD");
}

/**
 * The GitHub side of a review: a bare origin with `refs/pull/7/head`, the author's clone, and the
 * user's own checkout under a Projects folder, with a branch and uncommitted work of its own.
 */
async function github(world: ScenarioWorld) {
  const root = join(await realpath(join(world.home, "..")), "github");
  const projects = join(root, "Projects");
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const checkout = join(projects, "work", "backend");
  await mkdir(projects, { recursive: true });
  await runCommand({ argv: ["git", "init", "-q", "--bare", "-b", "main", origin], cwd: root });
  await runCommand({ argv: ["git", "clone", "-q", origin, author], cwd: root });
  await git(author, "checkout", "-q", "-b", "main");
  await commit(author, "src/upload.ts", "send(file);\n");
  await git(author, "push", "-q", "origin", "main");
  await git(author, "checkout", "-q", "-b", "retry");
  await commit(author, "src/upload.ts", "retry(send, file);\nlog(file);\n");
  await git(author, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  await runCommand({ argv: ["git", "clone", "-q", origin, checkout], cwd: root });
  await git(checkout, "remote", "set-url", "origin", "git@github.com:acme/api.git");
  await git(checkout, "checkout", "-q", "-b", "my-work");
  await writeFile(join(checkout, "notes.txt"), "mine\n");
  return { root, projects, origin, author, checkout };
}

type Posted = { body: string; stdin: string };

/** Scripted `gh` and Lavish; real git for the PR checkout; the scenario world for the rest. */
function composite(world: ScenarioWorld, prRoot: string, author: string, origin: string) {
  const posted: Posted[] = [];
  const replies: string[] = [];
  const reviews: Record<string, unknown>[] = [];
  const run: CommandRunner = async (request: CommandRequest): Promise<CommandResult> => {
    const [program, flag, path] = request.argv;
    if (program === "git" && flag === "-C" && path !== undefined) {
      if (path.startsWith(prRoot) || path.startsWith(join(world.home, "pr-review"))) {
        // The checkout's origin names GitHub; fetches go to the local stand-in instead.
        const argv = request.argv.includes("fetch")
          ? request.argv.map((word) => (word === "origin" ? origin : word))
          : request.argv;
        return runCommand({ ...request, argv });
      }
    }
    if (program === "lavish-axi") {
      return {
        code: 0,
        stdout:
          "session:\n  status: waiting\n  session_ended: false\n  url: http://127.0.0.1:4387/session/review\n",
        stderr: "",
      };
    }
    if (program !== "gh") return world.run(request);
    const line = request.argv.join(" ");
    const head = await git(author, "rev-parse", "HEAD");
    if (line.includes("--json headRefOid")) return ok(`${head}\n`);
    if (line.startsWith("gh pr view 7 --repo acme/api")) {
      return ok(
        JSON.stringify({
          number: 7,
          url: URL,
          title: "Retry uploads",
          body: "Retries failed uploads.",
          author: { login: "sam" },
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: head,
          baseRefName: "main",
          additions: 2,
          deletions: 1,
          changedFiles: 1,
          closingIssuesReferences: [],
          statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      );
    }
    if (line === "gh api user --jq .login") return ok("me\n");
    if (line.startsWith("gh api --paginate --slurp repos/acme/api/pulls/7/comments")) {
      return ok(
        JSON.stringify([
          posted.length === 0
            ? []
            : [
                {
                  id: 501,
                  user: { login: "me" },
                  path: "src/upload.ts",
                  line: 1,
                  body: "Could we cap retries?",
                },
              ],
        ]),
      );
    }
    if (line.startsWith("gh api --paginate --slurp repos/acme/api/pulls/7/reviews")) {
      return ok(JSON.stringify([reviews]));
    }
    if (line.startsWith("gh api --method POST repos/acme/api/pulls/7/reviews")) {
      const body = JSON.parse(request.stdin ?? "{}") as { body: string };
      posted.push({ body: body.body, stdin: request.stdin ?? "" });
      const url = `${URL}#pullrequestreview-${posted.length}`;
      reviews.push({ body: body.body, html_url: url });
      return ok(JSON.stringify({ html_url: url }));
    }
    if (line.startsWith("gh api --method POST repos/acme/api/pulls/7/comments/501/replies")) {
      replies.push(line);
      return ok("{}");
    }
    return { code: 1, stdout: "", stderr: `unscripted: ${line}` };
  };
  return { run, posted, replies };
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

async function latestJob(world: ScenarioWorld, taskId: string) {
  const snapshot = await world.snapshot();
  const job = snapshot.runtime.tasks.find((entry) => entry.taskId === taskId)?.jobs.at(-1);
  if (job === undefined) throw new Error("no worker job was launched");
  return { job, spec: parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8"))) };
}

async function finishRun(
  world: ScenarioWorld,
  service: TandemService,
  taskId: string,
  text: string,
): Promise<TaskRecord> {
  const { job, spec } = await latestJob(world, taskId);
  const revision = spec.communication?.initialRevision ?? 0;
  if (spec.communication !== undefined) {
    // A real worker proves it applied the instructions it started with.
    await writeWorkerReceipt(spec.communication.receiptPath, {
      schemaVersion: 1,
      jobId: job.id,
      taskId,
      generation: job.generation,
      receivedRevision: revision,
      appliedRevision: revision,
      heartbeatAt: SCENARIO_NOW,
      progressAt: SCENARIO_NOW,
      phase: "model",
    });
  }
  await persistWorkerResult(job.resultPath, {
    id: job.id,
    taskId,
    generation: job.generation,
    role: "scout",
    status: "completed",
    text,
    finishedAt: SCENARIO_NOW,
    instructionRevision: revision,
  });
  // The worker has exited back to the pane's shell, as it does after submitting its report.
  if (job.endpoint !== undefined) world.replaceForeground(job.endpoint.paneId, ["sh"]);
  await service.tick();
  return service.get(taskId);
}

function review(head: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    head,
    intent: "Retries failed uploads and logs each attempt.",
    verdict: "Safe to merge once the retries are capped.",
    tour: [
      {
        title: "Retrying",
        why: "How an upload is retried",
        stops: [
          { file: "src/upload.ts", from: 1, to: 2, title: "The retry", body: "Wraps send." },
          { file: "src/other.ts", from: 1, to: 3, title: "Elsewhere", body: "Not in the diff." },
        ],
      },
    ],
    concerns: [
      { title: "Unbounded retries", detail: "Nothing caps the retries.", severity: "blocking" },
    ],
    comments: [
      {
        id: "c1",
        file: "src/upload.ts",
        line: 1,
        body: "Could we cap retries?",
        severity: "blocking",
      },
      { id: "c2", file: "src/upload.ts", line: 2, body: "nit: log level?", severity: "nit" },
      {
        id: "c3",
        file: "src/other.ts",
        line: 9,
        body: "Is this still used?",
        severity: "question",
      },
    ],
    summaryComment: "Nice, a couple of thoughts.",
    ...extra,
  });
}

test("a PR review runs end to end: start, review, edit, post, re-review, question, close", async () => {
  await withScenario({}, async (world) => {
    const pr = await github(world);
    const fake = composite(world, pr.root, pr.author, pr.origin);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: fake.run,
      clock: world.clock,
      idFactory: world.idFactory,
      projectRoots: [pr.projects],
    });

    const started = await service.reviewPr({ pullRequest: URL, repoPath: world.repoPath });
    expect(started).toMatchObject({
      kind: "started",
      message: "Reviewing acme/api#7. Small PR, about a 1-minute read. CI green.",
    });
    if (started.kind !== "started") throw new Error("not started");
    const taskId = started.taskId;
    expect(await service.reviewPr({ pullRequest: URL, repoPath: world.repoPath })).toMatchObject({
      kind: "existing",
      taskId,
    });

    const running = await service.get(taskId);
    expect(running.kind).toBe("pr-review");
    expect(running.stage).toBe("scouting");
    const first = await latestJob(world, taskId);
    const firstHead = await git(pr.author, "rev-parse", "HEAD");
    expect(first.spec.prReview).toEqual({
      structuredReport: true,
      diffPath: join(world.home, "pr-review", taskId, "run-0", "diff.patch"),
      inlineComments: true,
    });
    expect(first.spec.prompt).toContain("diff-numbered.patch");
    expect(first.spec.prompt).toContain("# Tandem PR review: acme/api#7");
    expect(first.spec.cwd).toBe(join(world.home, "pr-review", taskId, "worktree"));
    expect(await git(first.spec.cwd, "rev-parse", "HEAD")).toBe(firstHead);

    const reviewed = await finishRun(world, service, taskId, review(firstHead));
    expect(reviewed.stage).toBe("completed");
    expect(reviewed.prReview?.rounds).toHaveLength(1);
    expect(reviewed.prReview?.rounds[0]?.review.comments.map((comment) => comment.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(reviewed.notifications.at(-1)?.message).toContain("review-show");
    expect(reviewed.cleanup?.status).toBe("retained");
    expect((await stat(first.spec.cwd)).isDirectory()).toBe(true);

    expect(reviewed.prReview?.rounds[0]?.review.tour).toEqual([
      {
        title: "Retrying",
        why: "How an upload is retried",
        stops: [{ file: "src/upload.ts", from: 1, to: 2, title: "The retry", body: "Wraps send." }],
      },
    ]);

    // The page itself is built by src/pr-review/page.ts; this checks the chat text.
    const shown = await service.reviewShow(taskId, { page: false });
    expect(shown.pageUrl).toBeUndefined();
    expect(shown.text).toContain("Retries failed uploads and logs each attempt.");
    expect(shown.text).toContain("Verdict: Safe to merge once the retries are capped.");
    expect(shown.text).toContain("   - src/upload.ts:1-2 The retry: Wraps send.");
    expect(shown.text).toContain("On `src/other.ts:9`: Is this still used?");
    expect(shown.text).toContain("1 tour stop pointed outside the diff");

    await expect(
      service.reviewEdit(taskId, { add: [{ file: "src/upload.ts", line: 9, body: "Mine" }] }),
    ).rejects.toThrow("Line 9 of src/upload.ts can't take a comment; lines that can: 1-2.");
    await service.reviewEdit(taskId, {
      comments: [
        { id: "c2", drop: true },
        { id: "c1", body: "Could we cap retries at 3?" },
      ],
      add: [{ file: "src/upload.ts", line: 2, body: "Could this log the attempt number?" }],
    });
    await expect(
      service.reviewPost(taskId, { verdict: "comment", approved: false }),
    ).rejects.toThrow("approval");
    const postedResult = await service.reviewPost(taskId, {
      verdict: "request-changes",
      approved: true,
    });
    expect(postedResult).toMatchObject({
      posted: true,
      message: expect.stringContaining("Posted 2 comments"),
    });
    expect(fake.posted).toHaveLength(1);
    const sent = JSON.parse(fake.posted[0]?.stdin ?? "{}");
    expect(sent).toMatchObject({ commit_id: firstHead, event: "REQUEST_CHANGES" });
    expect(sent.comments).toEqual([
      { path: "src/upload.ts", line: 1, side: "RIGHT", body: "Could we cap retries at 3?" },
      {
        path: "src/upload.ts",
        line: 2,
        side: "RIGHT",
        body: "Could this log the attempt number?",
      },
    ]);
    expect(await service.reviewPost(taskId, { verdict: "comment", approved: true })).toMatchObject({
      message: expect.stringContaining("Already posted"),
    });
    expect(fake.posted).toHaveLength(1);

    const pushed = await commit(pr.author, "src/upload.ts", "retry(send, file, 3);\nlog(file);\n");
    await git(pr.author, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    await service.reviewAgain(taskId);
    const second = await latestJob(world, taskId);
    expect(second.spec.generation).toBe(1);
    const context = await readFile(
      join(world.home, "pr-review", taskId, "run-1", "context.md"),
      "utf8",
    );
    expect(context).toContain(`Reviewed range: ${firstHead}..${pushed}`);
    expect(context).toContain("[commentId 501] me on src/upload.ts:1: Could we cap retries?");
    const rereviewed = await finishRun(
      world,
      service,
      taskId,
      review(pushed, {
        comments: [],
        concerns: [],
        priorComments: [{ commentId: 501, status: "addressed", reply: "Looks good, thanks!" }],
      }),
    );
    expect(rereviewed.prReview?.rounds).toHaveLength(2);
    expect(rereviewed.prReview?.rounds[1]?.from).toBe(firstHead);
    // A Submit from the review page posts without a second approval.
    const submitted = await service.reviewSubmit(taskId, {
      tandemPrReview: 1,
      verdict: "approve",
      summary: "Thanks, this looks good now.",
      drafts: [],
      yours: [],
    });
    expect(submitted).toMatchObject({ posted: true });
    expect(JSON.parse(fake.posted[1]?.stdin ?? "{}")).toMatchObject({
      commit_id: pushed,
      event: "APPROVE",
      body: expect.stringContaining("Thanks, this looks good now."),
    });
    expect(fake.replies).toHaveLength(1);

    await service.steer({ taskId, text: "Why does retry take the file handle?" });
    const question = await latestJob(world, taskId);
    expect(question.spec.prReview).toMatchObject({ structuredReport: false });
    expect(question.spec.prompt).toContain("Why does retry take the file handle?");
    const answered = await finishRun(
      world,
      service,
      taskId,
      "Outcome: completed\n\nIt reopens the file on each attempt.",
    );
    expect(answered.prReview?.rounds).toHaveLength(2);
    expect(answered.notifications.at(-1)?.message).toContain("report.txt");

    const closed = await service.reviewClose(taskId);
    expect(closed.cleanup?.status).toBe("released");
    await expect(stat(first.spec.cwd)).rejects.toThrow();
    expect(await git(pr.checkout, "for-each-ref", "refs/tandem")).toBe("");
    expect(await git(pr.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("my-work");
    expect(await readFile(join(pr.checkout, "notes.txt"), "utf8")).toBe("mine\n");
    await service.shutdown();
  });
}, 20_000);

test("a PR whose repository is not on disk asks where it is, then remembers the answer", async () => {
  await withScenario({}, async (world) => {
    const pr = await github(world);
    const fake = composite(world, pr.root, pr.author, pr.origin);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: fake.run,
      clock: world.clock,
      idFactory: world.idFactory,
      projectRoots: [join(pr.root, "Elsewhere")],
    });
    expect(await service.reviewPr({ pullRequest: URL, repoPath: world.repoPath })).toEqual({
      kind: "needs-location",
      repo: "acme/api",
      paths: [],
      message: `Where's acme/api on your machine? Or say "clone it".`,
      nextStep: expect.stringContaining("call review-pr again with checkout"),
    });
    expect(
      await service.reviewPr({ pullRequest: URL, repoPath: world.repoPath, checkout: pr.author }),
    ).toMatchObject({
      kind: "needs-location",
      message: expect.stringContaining("isn't a checkout"),
    });
    const started = await service.reviewPr({
      pullRequest: URL,
      repoPath: world.repoPath,
      checkout: pr.checkout,
    });
    expect(started.kind).toBe("started");
    await service.shutdown();
  });
});
