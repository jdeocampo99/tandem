import { z } from "zod";
import { runChecked } from "../adapters/primitives.ts";
import type { CommandRunner, IsoTimestamp } from "../contracts.ts";
import { checkOutcome, parseRemoteCheck } from "../delivery/pull-requests.ts";
import type { CachedPullRequest, PrCheck, PrComment, PrThread } from "../pr-review/native-view.ts";
import type { PullRequestRef } from "../pr-review/pull-request.ts";

const author = z.object({ login: z.string() }).nullable();
const comment = z.object({
  id: z.union([z.string(), z.number()]),
  author,
  createdAt: z.string(),
  body: z.string(),
  url: z.string().optional(),
});
const viewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  body: z.string(),
  commits: z.array(z.unknown()),
  additions: z.number().nonnegative(),
  deletions: z.number().nonnegative(),
  statusCheckRollup: z.array(z.unknown()).nullable(),
  comments: z.array(comment),
  reviews: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      author,
      submittedAt: z.string().nullable(),
      body: z.string(),
    }),
  ),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  diffSide: z.enum(["LEFT", "RIGHT"]),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.object({ nodes: z.array(comment), pageInfo }),
});
const threadPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        reviewThreads: z.object({ nodes: z.array(threadSchema), pageInfo }),
      }),
    }),
  }),
});
const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){nodes{id path line diffSide isResolved isOutdated comments(first:100){nodes{id author{login} createdAt body url} pageInfo{hasNextPage endCursor}}}pageInfo{hasNextPage endCursor}}}}}`;
const COMMENT_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id author{login} createdAt body url}pageInfo{hasNextPage endCursor}}}}}`;
const commentPage = z.object({
  data: z.object({ node: z.object({ comments: z.object({ nodes: z.array(comment), pageInfo }) }) }),
});

/** One bounded cache refresh. A head moving mid-read is refused so diff anchors never mix commits. */
export async function readNativePullRequest(
  run: CommandRunner,
  ref: PullRequestRef,
  cwd: string,
  now: IsoTimestamp,
): Promise<CachedPullRequest> {
  const fields =
    "number,title,url,headRefOid,isDraft,body,commits,additions,deletions,statusCheckRollup,comments,reviews";
  const result = await runChecked(
    run,
    {
      argv: ["gh", "pr", "view", String(ref.number), "--repo", ref.repo, "--json", fields],
      cwd,
      timeoutMs: 15_000,
    },
    "native PR cache",
  );
  const view = viewSchema.parse(JSON.parse(result.stdout));
  if (view.number !== ref.number) throw new TypeError("GitHub returned another PR");
  if (view.statusCheckRollup === null) throw new TypeError("GitHub did not report checks");
  const [patch, threads] = await Promise.all([
    runChecked(
      run,
      {
        argv: ["gh", "pr", "diff", String(ref.number), "--repo", ref.repo],
        cwd,
        timeoutMs: 15_000,
      },
      "native PR diff",
    ),
    readNativeThreads(run, ref, cwd, view.headRefOid),
  ]);
  // Diff has no embedded head identity. Re-read it after the diff to prove the snapshot stayed put.
  const after = await runChecked(
    run,
    {
      argv: ["gh", "pr", "view", String(ref.number), "--repo", ref.repo, "--json", "headRefOid"],
      cwd,
      timeoutMs: 15_000,
    },
    "native PR head",
  );
  if (
    z.object({ headRefOid: z.string() }).parse(JSON.parse(after.stdout)).headRefOid !==
    view.headRefOid
  )
    throw new Error("PR changed during cache refresh");
  const checks: PrCheck[] = view.statusCheckRollup.map((value, index) => {
    const check = parseRemoteCheck(value, index, "native PR checks");
    const outcome = checkOutcome(check);
    const completedAt = z
      .object({ completedAt: z.string().optional().nullable() })
      .parse(value).completedAt;
    return {
      name: check.name,
      state:
        outcome === "passed"
          ? "passed"
          : outcome === "failed"
            ? "failed"
            : check.state === "IN_PROGRESS"
              ? "running"
              : "pending",
      ...(check.startedAt === undefined ? {} : { startedAt: check.startedAt }),
      ...(completedAt === undefined || completedAt === null || completedAt === ""
        ? {}
        : { completedAt }),
      ...(check.url === undefined ? {} : { logUrl: check.url }),
    };
  });
  return {
    repo: ref.repo,
    number: ref.number,
    title: view.title,
    url: view.url,
    head: view.headRefOid,
    draft: view.isDraft,
    body: view.body,
    commits: view.commits.length,
    additions: view.additions,
    deletions: view.deletions,
    readAt: now,
    checks,
    threads,
    patch: patch.stdout,
    tour: [],
    conversation: [
      ...view.comments.map(toComment),
      ...view.reviews
        .filter((review) => review.submittedAt !== null)
        .map((review) => ({
          id: String(review.id),
          author: review.author?.login ?? "deleted user",
          at: review.submittedAt ?? now,
          body: review.body,
        })),
    ].toSorted((a, b) => a.at.localeCompare(b.at)),
  };
}

async function readNativeThreads(
  run: CommandRunner,
  ref: PullRequestRef,
  cwd: string,
  head: string,
): Promise<readonly PrThread[]> {
  const [owner, name] = ref.repo.split("/");
  if (owner === undefined || name === undefined)
    throw new TypeError("PR repository must be owner/name");
  const output: PrThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await runChecked(
      run,
      {
        argv: [
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${THREAD_QUERY}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${ref.number}`,
          ...(cursor === null ? [] : ["-f", `cursor=${cursor}`]),
        ],
        cwd,
        timeoutMs: 15_000,
      },
      "native PR threads",
    );
    const pr = threadPage.parse(JSON.parse(result.stdout)).data.repository.pullRequest;
    if (pr.headRefOid !== head) throw new Error("PR changed while reading threads");
    for (const thread of pr.reviewThreads.nodes) {
      const comments = thread.comments.nodes.map(toComment);
      let replies = thread.comments.pageInfo;
      for (let replyPage = 0; replies.hasNextPage; replyPage++) {
        if (replyPage >= 100 || replies.endCursor === null)
          throw new Error("PR thread pagination incomplete");
        const more = await runChecked(
          run,
          {
            argv: [
              "gh",
              "api",
              "graphql",
              "-f",
              `query=${COMMENT_QUERY}`,
              "-f",
              `id=${thread.id}`,
              "-f",
              `cursor=${replies.endCursor}`,
            ],
            cwd,
            timeoutMs: 15_000,
          },
          "native PR replies",
        );
        const parsed = commentPage.parse(JSON.parse(more.stdout)).data.node.comments;
        comments.push(...parsed.nodes.map(toComment));
        replies = parsed.pageInfo;
      }
      output.push({
        id: thread.id,
        file: thread.path,
        side: thread.diffSide,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        ...(thread.line === null ? {} : { line: thread.line }),
        comments,
      });
    }
    if (!pr.reviewThreads.pageInfo.hasNextPage) return output;
    cursor = pr.reviewThreads.pageInfo.endCursor;
    if (cursor === null) throw new Error("PR thread pagination incomplete");
  }
  throw new Error("PR thread pagination exceeded safety bound");
}
function toComment(value: z.infer<typeof comment>): PrComment {
  return {
    id: String(value.id),
    author: value.author?.login ?? "deleted user",
    at: value.createdAt,
    body: value.body,
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}
