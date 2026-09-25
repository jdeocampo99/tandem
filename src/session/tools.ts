import { z } from "zod/v4";
import { type AgentRole, MODEL_ROLE_ORDER } from "../contracts.ts";
import type { WorkerRole } from "../workers/jobs.ts";
import { outcomesFor } from "../workers/protocol.ts";

const pullRequestSummarySchema = z.strictObject({
  tldr: z.array(z.string()),
  what: z.array(z.string()),
  why: z.array(z.string()),
});

const modelSpecSchema = z.strictObject({
  model: z.string(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
});

const modelAssignmentsSchema = z.strictObject(
  Object.fromEntries(MODEL_ROLE_ORDER.map((role) => [role, modelSpecSchema] as const)) as Record<
    AgentRole,
    typeof modelSpecSchema
  >,
);

const briefContentSchema = z.strictObject({
  goal: z.string(),
  scope: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  manualVerification: z.array(z.string()),
  recommendedApproach: z.string(),
  keyDecisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  researchLinks: z.array(z.string()),
  skipReview: z.boolean().optional(),
});

/** The strict `{ request: { action, ... } }` parameters of the `tandem` tool; see `TandemAction`. */
export const tandemRequestSchema = z.strictObject({
  request: z.union([
    z.strictObject({ action: z.literal("restart"), taskId: z.string() }),
    z.strictObject({ action: z.literal("onboard"), repoPath: z.string() }),
    z.strictObject({ action: z.literal("setup"), repoPath: z.string() }),
    z.strictObject({ action: z.literal("models"), repoPath: z.string() }),
    z.strictObject({
      action: z.literal("configure-models"),
      repoPath: z.string(),
      models: modelAssignmentsSchema,
      enabledProviders: z.array(z.string()).optional(),
    }),
    z.strictObject({
      action: z.literal("create"),
      repoPath: z.string(),
      requestId: z
        .string()
        .optional()
        .describe("The approved request this work belongs to; required when several are open."),
      kind: z.enum(["scout", "implementation"]),
      objective: z.string(),
      acceptanceCriteria: z.array(z.string()),
      manualVerification: z.array(z.string()).optional(),
      surfaces: z.array(z.string()),
      researchTaskIds: z.array(z.string()).optional(),
      skills: z
        .array(z.string())
        .optional()
        .describe("Skills the user asked this work to use, by exact name. Tandem loads them."),
      targetRepo: z
        .string()
        .optional()
        .describe("Another repository to work in, as owner/repo. Leave out for this project."),
      targetCheckout: z
        .string()
        .optional()
        .describe("A path the user gave for the target repository."),
      targetClone: z
        .boolean()
        .optional()
        .describe("True when the user said to clone the target repository."),
      validationCommands: z
        .array(z.string())
        .optional()
        .describe(
          "Commands that check work in a target repository with none saved, e.g. bun test.",
        ),
    }),
    z.strictObject({ action: z.literal("list") }),
    z.strictObject({ action: z.literal("presentations") }),
    z.strictObject({ action: z.literal("presentation-open"), presentationId: z.string() }),
    z.strictObject({
      action: z.literal("show"),
      taskId: z.string(),
      detail: z.enum(["summary", "full"]).optional(),
    }),
    z.strictObject({
      action: z.literal("steer"),
      taskId: z.string(),
      text: z.string(),
      supersedes: z.array(z.string()).optional(),
    }),
    z.strictObject({
      action: z.literal("answer"),
      taskId: z.string(),
      questionId: z.string(),
      text: z.string(),
    }),
    z.strictObject({ action: z.literal("messages"), taskId: z.string() }),
    z.strictObject({ action: z.literal("inspect"), taskId: z.string() }),
    z.strictObject({
      action: z.literal("delivery-preflight"),
      taskId: z.string(),
      base: z.string(),
    }),
    z.strictObject({ action: z.literal("approve"), taskId: z.string() }),
    z.strictObject({
      action: z.literal("brief-draft"),
      repoPath: z.string(),
      requestId: z.string().optional(),
      content: briefContentSchema,
      reviewPane: z.boolean(),
    }),
    z.strictObject({ action: z.literal("brief-review"), requestId: z.string() }),
    z.strictObject({ action: z.literal("brief-show"), requestId: z.string() }),
    z.strictObject({ action: z.literal("request-receipt"), requestId: z.string().optional() }),
    z.strictObject({
      action: z.literal("brief-approve"),
      /** Omitted resolves to the one request whose brief is awaiting approval. */
      requestId: z.string().optional(),
      briefRevision: z.number().int().positive(),
      contentDigest: z.string(),
    }),
    z.strictObject({ action: z.literal("tick") }),
    z.strictObject({
      action: z.literal("pause"),
      taskId: z.string(),
      reason: z.string().optional(),
    }),
    z.strictObject({ action: z.literal("resume"), taskId: z.string() }),
    z.strictObject({
      action: z.literal("cancel"),
      taskId: z.string(),
      reason: z.string().optional(),
      discard: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal("present"),
      taskId: z.string(),
      objective: z.string(),
      artifacts: z.array(z.string()),
    }),
    z.strictObject({
      action: z.literal("describe"),
      taskId: z.string(),
      summary: pullRequestSummarySchema,
    }),
    z.strictObject({
      action: z.literal("publish"),
      taskId: z.string(),
      title: z.string(),
      base: z.string(),
      summary: pullRequestSummarySchema,
    }),
    z.strictObject({
      action: z.literal("publish-now"),
      taskId: z.string(),
      repository: z.string(),
      title: z.string(),
      base: z.string(),
      summary: pullRequestSummarySchema,
    }),
    z.strictObject({
      action: z.literal("draft"),
      taskId: z.string(),
      title: z.string(),
      base: z.string(),
    }),
    z.strictObject({
      action: z.literal("merge"),
      taskId: z.string(),
      method: z.enum(["merge", "squash", "rebase"]),
    }),
    z.strictObject({
      action: z.literal("cleanup"),
      taskIds: z.array(z.string()).min(1),
      discard: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal("review-pr"),
      pullRequest: z.string().describe("A GitHub PR URL or owner/repo#123."),
      repoPath: z.string(),
      lens: z.enum(["full", "intent", "focus"]).optional(),
      focus: z
        .string()
        .optional()
        .describe("For lens focus: the user's words, e.g. the migration."),
      checkout: z.string().optional().describe("A path the user gave for the repository."),
      clone: z.boolean().optional().describe("True when the user said to clone it."),
    }),
    z.strictObject({
      action: z.literal("review-show"),
      taskId: z.string(),
      page: z.boolean().optional(),
    }),
    z.strictObject({ action: z.literal("review-notes"), taskId: z.string() }),
    z.strictObject({
      action: z.literal("review-edit"),
      taskId: z.string(),
      comments: z
        .array(
          z.strictObject({
            id: z.string(),
            body: z.string().optional(),
            severity: z.enum(["blocking", "question", "suggestion", "nit"]).optional(),
            drop: z.boolean().optional(),
          }),
        )
        .optional(),
      summaryComment: z.string().optional(),
    }),
    z.strictObject({
      action: z.literal("review-post"),
      taskId: z.string(),
      verdict: z.enum(["comment", "approve", "request-changes"]),
    }),
    z.strictObject({ action: z.literal("review-again"), taskId: z.string() }),
    z.strictObject({ action: z.literal("review-close"), taskId: z.string() }),
  ]),
});

export const reviewResultSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      id: z.string(),
      severity: z.enum(["P0", "P1", "P2", "P3"]),
      verdict: z.enum(["confirmed", "plausible"]),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      description: z.string(),
    }),
  ),
  summary: z.string(),
});

/** The `submit_report` parameters for one role: presentations add an artifact, reviewers a review. */
export function submitReportSchema(role: WorkerRole) {
  const reviews = role === "reviewer";
  return z.strictObject({
    outcome: z.enum(outcomesFor(role)),
    report: z
      .string()
      .optional()
      .describe(
        reviews
          ? "Optional context for a needs-decision or failed outcome."
          : "The full report body in Markdown.",
      ),
    question: z
      .string()
      .optional()
      .describe("Required for needs-decision: one bounded single-line question."),
    recommendation: z
      .string()
      .optional()
      .describe("Optional for needs-decision: one bounded single-line recommendation."),
    ...(role === "presentation"
      ? {
          artifactPath: z
            .string()
            .optional()
            .describe("Required for completed: the absolute path of the written artifact."),
        }
      : {}),
    ...(reviews
      ? {
          review: reviewResultSchema
            .optional()
            .describe(
              "Required for completed: your findings and summary. Tandem records the commit and whether the review passes.",
            ),
        }
      : {}),
  });
}

export const copyAssetSchema = z.strictObject({
  from: z.string().describe("Path of the file in the repository checkout."),
  name: z.string().describe("Plain file name to save it as in the mockup folder."),
});
