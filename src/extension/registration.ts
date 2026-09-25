import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ompToolParameters } from "../adapters/omp-tool-schema.ts";
import { type AgentRole, MODEL_ROLE_ORDER } from "../contracts.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import type { TandemService } from "../service/controller.ts";
import {
  runTandemCommand,
  runTandemTool,
  type TandemCallDependencies,
} from "../session/actions.ts";
import {
  type ChoiceConfirmation,
  type PromptRoutingConfig,
  routeUserPrompt,
} from "../session/prompt-routing.ts";
import { coordinatorToolRefusal } from "../session/tool-guard.ts";
import { tandemRequestSchema as tandemToolSchema } from "../session/tools.ts";
import { ompApprovalDialog, ompMcpToolPrefix, ompSessionHost, ompToolCall } from "./omp-host.ts";

export type TandemOmpRegistrationDependencies = Readonly<{
  readonly getService: (ctx: ExtensionContext) => TandemService;
  readonly getHome: (ctx: ExtensionContext) => string;
  /** The project a routed PR review runs under; without it, PR links go to the coordinator. */
  readonly getRepo?: (ctx: ExtensionContext) => string;
  readonly promptRouting: PromptRoutingConfig;
  readonly reconcile: (ctx: ExtensionContext, runTick: boolean) => Promise<void>;
  readonly postAction: (ctx: ExtensionContext) => Promise<void>;
  /** The MCP servers this project lets the coordinator use itself. */
  readonly coordinatorMcpServers: (ctx: ExtensionContext) => Promise<readonly string[]>;
  /** Whether a research task for this project is queued or running. */
  readonly researchRunning: (ctx: ExtensionContext) => Promise<boolean>;
}>;

export function registerTandemOmp(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  registerPromptRouting(pi, dependencies);
  registerCoordinatorToolGuard(pi, dependencies);
  registerTandemTool(pi, dependencies);
  registerTandemCommand(pi, dependencies);
}

function callDependencies(
  ctx: ExtensionContext,
  dependencies: TandemOmpRegistrationDependencies,
): TandemCallDependencies {
  return {
    service: () => dependencies.getService(ctx),
    confirm: ompApprovalDialog(ctx),
    reconcile: () => dependencies.reconcile(ctx, false),
    postAction: () => dependencies.postAction(ctx),
  };
}

function registerPromptRouting(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  const confirmation: ChoiceConfirmation = {};
  pi.on("input", async (event, ctx) => {
    const { getRepo } = dependencies;
    const reply = await routeUserPrompt(
      {
        type: "userPrompt",
        text: event.text,
        interactive: event.source === "interactive",
        attachments: event.images?.length ?? 0,
      },
      {
        confirmation,
        config: dependencies.promptRouting,
        service: () => dependencies.getService(ctx),
        ...(getRepo === undefined ? {} : { repoPath: () => getRepo(ctx) }),
        host: ompSessionHost(pi, () => ctx),
        confirm: ompApprovalDialog(ctx),
        diagnostics: (entry) => appendDiagnosticEvent(dependencies.getHome(ctx), entry),
      },
    );
    return reply.handled ? { handled: true } : undefined;
  });
}

function registerCoordinatorToolGuard(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  pi.on("tool_call", async (event, ctx) => {
    const reason = await coordinatorToolRefusal(ompToolCall(event), {
      allowedServers: () => dependencies.coordinatorMcpServers(ctx),
      researchRunning: () => dependencies.researchRunning(ctx),
      mcpToolPrefix: ompMcpToolPrefix,
      home: dependencies.getHome(ctx),
      cwd: ctx.cwd,
      userHome: homedir(),
      realpath: (path) => realpath(path),
    });
    return reason === undefined ? undefined : { block: true, reason };
  });
}

function registerTandemTool(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  pi.registerTool({
    name: "tandem",
    label: "Tandem",
    description:
      "Start, inspect, steer, and control Tandem work with {request:{action:...}}. Actions that need approval ask the user to confirm. A delivered message does not mean the work is done.",
    parameters: ompToolParameters(tandemToolSchema),
    strict: true,
    approval: "write",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { request } = tandemToolSchema.parse(params);
      const outcome = await runTandemTool(request, callDependencies(ctx, dependencies), signal);
      return {
        content: [{ type: "text", text: outcome.text }],
        details: outcome.details,
        ...(outcome.isError ? { isError: true } : {}),
      };
    },
  });
}

function registerTandemCommand(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  pi.registerCommand("tandem", {
    description:
      "Inspect or control Tandem: restart, list, presentations, show, messages, models, onboard, setup, create, approve, brief-show, brief-review, brief-approve, request-receipt, steer, answer, tick, pause, resume, cancel, present, presentation-open, feedback, describe, draft, publish, merge, cleanup.",
    handler: (args, ctx) =>
      runTandemCommand(
        args,
        ctx.cwd,
        callDependencies(ctx, dependencies),
        ompSessionHost(pi, () => ctx),
      ),
  });
}

// The old pi.zod builder, kept only for the schema parity test in tests/session/tools.test.ts.
type Zod = ExtensionAPI["zod"];

function pullRequestSummarySchema(z: Zod) {
  return z
    .object({
      tldr: z.array(z.string()),
      what: z.array(z.string()),
      why: z.array(z.string()),
    })
    .strict();
}

/** The strict `{ request: { action, ... } }` parameters of the `tandem` tool; see `TandemAction`. */
export function tandemRequestSchema(z: Zod) {
  const modelSpecSchema = z
    .object({
      model: z.string(),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
    })
    .strict();
  const modelAssignmentsShape = Object.fromEntries(
    MODEL_ROLE_ORDER.map((role) => [role, modelSpecSchema] as const),
  ) as Record<AgentRole, typeof modelSpecSchema>;
  const modelAssignmentsSchema = z.object(modelAssignmentsShape).strict();
  const briefContentSchema = z
    .object({
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
    })
    .strict();
  const actionSchema = z.union([
    z.object({ action: z.literal("restart"), taskId: z.string() }).strict(),
    z.object({ action: z.literal("onboard"), repoPath: z.string() }).strict(),
    z.object({ action: z.literal("setup"), repoPath: z.string() }).strict(),
    z.object({ action: z.literal("models"), repoPath: z.string() }).strict(),
    z
      .object({
        action: z.literal("configure-models"),
        repoPath: z.string(),
        models: modelAssignmentsSchema,
        enabledProviders: z.array(z.string()).optional(),
      })
      .strict(),
    z
      .object({
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
        skill: z.object({ name: z.string(), context: z.string() }).strict().optional(),
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
      })
      .strict(),
    z.object({ action: z.literal("list") }).strict(),
    z.object({ action: z.literal("presentations") }).strict(),
    z.object({ action: z.literal("presentation-open"), presentationId: z.string() }).strict(),
    z
      .object({
        action: z.literal("show"),
        taskId: z.string(),
        detail: z.enum(["summary", "full"]).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("steer"),
        taskId: z.string(),
        text: z.string(),
        supersedes: z.array(z.string()).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("answer"),
        taskId: z.string(),
        questionId: z.string(),
        text: z.string(),
      })
      .strict(),
    z.object({ action: z.literal("messages"), taskId: z.string() }).strict(),
    z.object({ action: z.literal("inspect"), taskId: z.string() }).strict(),
    z
      .object({
        action: z.literal("delivery-preflight"),
        taskId: z.string(),
        base: z.string(),
      })
      .strict(),
    z.object({ action: z.literal("approve"), taskId: z.string() }).strict(),
    z
      .object({
        action: z.literal("brief-draft"),
        repoPath: z.string(),
        requestId: z.string().optional(),
        content: briefContentSchema,
        reviewPane: z.boolean(),
      })
      .strict(),
    z.object({ action: z.literal("brief-review"), requestId: z.string() }).strict(),
    z.object({ action: z.literal("brief-show"), requestId: z.string() }).strict(),
    z.object({ action: z.literal("request-receipt"), requestId: z.string().optional() }).strict(),
    z
      .object({
        action: z.literal("brief-approve"),
        /** Omitted resolves to the one request whose brief is awaiting approval. */
        requestId: z.string().optional(),
        briefRevision: z.number().int().positive(),
        contentDigest: z.string(),
      })
      .strict(),
    z.object({ action: z.literal("tick") }).strict(),
    z
      .object({ action: z.literal("pause"), taskId: z.string(), reason: z.string().optional() })
      .strict(),
    z.object({ action: z.literal("resume"), taskId: z.string() }).strict(),
    z
      .object({
        action: z.literal("cancel"),
        taskId: z.string(),
        reason: z.string().optional(),
        discard: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("present"),
        taskId: z.string(),
        objective: z.string(),
        artifacts: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        action: z.literal("describe"),
        taskId: z.string(),
        summary: pullRequestSummarySchema(z),
      })
      .strict(),
    z
      .object({
        action: z.literal("publish"),
        taskId: z.string(),
        title: z.string(),
        base: z.string(),
        summary: pullRequestSummarySchema(z),
      })
      .strict(),
    z
      .object({
        action: z.literal("publish-now"),
        taskId: z.string(),
        repository: z.string(),
        title: z.string(),
        base: z.string(),
        summary: pullRequestSummarySchema(z),
      })
      .strict(),
    z
      .object({
        action: z.literal("draft"),
        taskId: z.string(),
        title: z.string(),
        base: z.string(),
      })
      .strict(),
    z
      .object({
        action: z.literal("merge"),
        taskId: z.string(),
        method: z.enum(["merge", "squash", "rebase"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("cleanup"),
        taskIds: z.array(z.string()).min(1),
        discard: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
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
      })
      .strict(),
    z
      .object({
        action: z.literal("review-show"),
        taskId: z.string(),
        page: z.boolean().optional(),
      })
      .strict(),
    z.object({ action: z.literal("review-notes"), taskId: z.string() }).strict(),
    z
      .object({
        action: z.literal("review-edit"),
        taskId: z.string(),
        comments: z
          .array(
            z
              .object({
                id: z.string(),
                body: z.string().optional(),
                severity: z.enum(["blocking", "question", "suggestion", "nit"]).optional(),
                drop: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
        summaryComment: z.string().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("review-post"),
        taskId: z.string(),
        verdict: z.enum(["comment", "approve", "request-changes"]),
      })
      .strict(),
    z.object({ action: z.literal("review-again"), taskId: z.string() }).strict(),
    z.object({ action: z.literal("review-close"), taskId: z.string() }).strict(),
  ]);

  return z.object({ request: actionSchema }).strict();
}
