import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type AgentRole, MODEL_ROLE_ORDER } from "../contracts.ts";
import type { TandemService } from "../service/controller.ts";
import {
  executeTandemAction,
  parseTandemCommand,
  type TandemAction,
  type TandemActionResult,
} from "./actions.ts";
import { handlePromptInput, type PromptRoutingConfig } from "./prompt-routing.ts";
import {
  ACTION_FULL_RESULT_MAX_CHARS,
  ACTION_RESULT_MAX_CHARS,
  boundedJson,
  compactText,
  summarizeTandemActionValue,
} from "./summary.ts";

export type TandemOmpRegistrationDependencies = Readonly<{
  readonly getService: (ctx: ExtensionContext) => TandemService;
  readonly getHome: (ctx: ExtensionContext) => string;
  readonly promptRouting: PromptRoutingConfig;
  readonly reconcile: (ctx: ExtensionContext, runTick: boolean) => Promise<void>;
  readonly postAction: (ctx: ExtensionContext) => Promise<void>;
}>;

type TandemToolDetails = Readonly<{
  readonly action: TandemAction["action"];
  readonly value?: unknown;
  readonly approved?: boolean;
  readonly detail?: "summary" | "full";
}>;

function renderActionResult(result: TandemActionResult): string {
  if (result.detail === "full") return boundedJson(result.value, ACTION_FULL_RESULT_MAX_CHARS);
  return summarizeTandemActionValue(result.action, result.value);
}

function toolResult(result: TandemActionResult): {
  content: { type: "text"; text: string }[];
  details: TandemToolDetails;
} {
  return {
    content: [{ type: "text", text: renderActionResult(result) }],
    details: {
      action: result.action,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.approved === undefined ? {} : { approved: result.approved }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    },
  };
}

function toolError(
  action: TandemAction["action"],
  error: unknown,
): {
  content: { type: "text"; text: string }[];
  details: TandemToolDetails;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: `Tandem ${action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`,
      },
    ],
    details: { action },
    isError: true,
  };
}

export function registerTandemOmp(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  const z = pi.zod;
  pi.on("input", (event, ctx) =>
    handlePromptInput(event, ctx, {
      config: dependencies.promptRouting,
      getService: dependencies.getService,
      getHome: dependencies.getHome,
      sendMessage: pi.sendMessage.bind(pi),
    }),
  );
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
        kind: z.enum(["scout", "implementation"]),
        objective: z.string(),
        acceptanceCriteria: z.array(z.string()),
        manualVerification: z.array(z.string()).optional(),
        surfaces: z.array(z.string()),
        researchTaskIds: z.array(z.string()).optional(),
        skill: z.object({ name: z.string(), context: z.string() }).strict().optional(),
      })
      .strict(),
    z.object({ action: z.literal("list") }).strict(),
    z.object({ action: z.literal("presentations") }).strict(),
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
    z.object({ action: z.literal("request-receipt"), requestId: z.string() }).strict(),
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
      .object({ action: z.literal("cancel"), taskId: z.string(), reason: z.string().optional() })
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
        summary: z
          .object({
            tldr: z.array(z.string()),
            what: z.array(z.string()),
            why: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("publish"),
        taskId: z.string(),
        title: z.string(),
        base: z.string(),
        summary: z
          .object({
            tldr: z.array(z.string()),
            what: z.array(z.string()),
            why: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("publish-now"),
        taskId: z.string(),
        repository: z.string(),
        title: z.string(),
        base: z.string(),
        summary: z
          .object({
            tldr: z.array(z.string()),
            what: z.array(z.string()),
            why: z.array(z.string()),
          })
          .strict(),
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
        taskId: z.string(),
        discard: z.boolean().optional(),
      })
      .strict(),
  ]);

  const requestSchema = z.object({ request: actionSchema }).strict();

  pi.registerTool({
    name: "tandem",
    label: "Tandem",
    description:
      "Start, inspect, steer, and control Tandem work with {request:{action:...}}. Actions that need approval ask the user to confirm. A delivered message does not mean the work is done.",
    parameters: requestSchema,
    strict: true,
    approval: "write",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = params.request;
      try {
        const result = await executeTandemAction(
          request,
          dependencies.getService(ctx),
          ctx,
          signal,
        );
        if (request.action === "tick") {
          await dependencies.reconcile(ctx, false);
        } else {
          await dependencies.postAction(ctx);
        }
        return toolResult(result);
      } catch (error) {
        return toolError(request.action, error);
      }
    },
  });
  pi.registerCommand("tandem", {
    description:
      "Inspect or control Tandem: restart, list, presentations, show, messages, models, onboard, setup, create, approve, brief-show, brief-review, brief-approve, request-receipt, steer, answer, tick, pause, resume, cancel, present, feedback, describe, draft, publish, merge, cleanup.",
    handler: async (args, ctx) => {
      try {
        const parsedAction = parseTandemCommand(args);
        const action =
          parsedAction.action === "models" && parsedAction.repoPath === "."
            ? { ...parsedAction, repoPath: ctx.cwd }
            : parsedAction;
        const result = await executeTandemAction(action, dependencies.getService(ctx), ctx);
        ctx.ui.notify(renderActionResult(result), "info");
        await dependencies.postAction(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Tandem command failed: ${message}`, "error");
      }
    },
  });
}
