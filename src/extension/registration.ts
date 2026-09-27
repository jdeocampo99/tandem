import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ompToolParameters } from "../adapters/omp-tool-schema.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import type { TandemService } from "../service/controller.ts";
import {
  runTandemCommand,
  runTandemTool,
  type TandemCallDependencies,
} from "../session/actions.ts";
import { explicitPlanningAnswer, planningAskCall } from "../session/planning-interview.ts";
import type { CoordinatorTurnAction } from "../session/events.ts";
import {
  type ChoiceConfirmation,
  type PromptRoutingConfig,
  routeUserPrompt,
} from "../session/prompt-routing.ts";
import { coordinatorToolRefusal } from "../session/tool-guard.ts";
import { tandemRequestSchema as tandemToolSchema } from "../session/tools.ts";
import {
  CARD_MESSAGE_TYPE,
  ompApprovalDialog,
  ompSessionHost,
  ompToolCall,
  renderCardMessage,
  renderStatusMessage,
  STATUS_MESSAGE_TYPE,
} from "./omp-host.ts";

export type TandemOmpRegistrationDependencies = Readonly<{
  readonly getService: (ctx: ExtensionContext) => TandemService;
  readonly getHome: (ctx: ExtensionContext) => string;
  /** The project a routed PR review runs under; without it, PR links go to the coordinator. */
  readonly getRepo?: (ctx: ExtensionContext) => string;
  readonly promptRouting: PromptRoutingConfig;
  readonly reconcile: (ctx: ExtensionContext, runTick: boolean) => Promise<void>;
  readonly postAction: (ctx: ExtensionContext) => Promise<void>;
  readonly recordTurnAction: (ctx: ExtensionContext, action: CoordinatorTurnAction) => void;
  /** The user's message is going to the model, so a thread opens or continues. */
  readonly userPrompt: (ctx: ExtensionContext) => void;
  readonly closeThread: (ctx: ExtensionContext) => void;
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
  pi.registerMessageRenderer(CARD_MESSAGE_TYPE, renderCardMessage);
  pi.registerMessageRenderer(STATUS_MESSAGE_TYPE, renderStatusMessage);
}

function callDependencies(
  ctx: ExtensionContext,
  dependencies: TandemOmpRegistrationDependencies,
): TandemCallDependencies {
  return {
    service: () => dependencies.getService(ctx),
    recordTurnAction: (action) => dependencies.recordTurnAction(ctx, action),
    confirm: ompApprovalDialog(ctx),
    reconcile: () => dependencies.reconcile(ctx, false),
    postAction: () => dependencies.postAction(ctx),
    closeThread: () => dependencies.closeThread(ctx),
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
    if (reply.handled) return { handled: true };
    if (event.source === "interactive") dependencies.userPrompt(ctx);
    return undefined;
  });
}

function registerCoordinatorToolGuard(
  pi: ExtensionAPI,
  dependencies: TandemOmpRegistrationDependencies,
): void {
  pi.on("tool_call", async (event, ctx) => {
    const toolCall = ompToolCall(event);
    if (event.toolName === "ask") {
      const planningCall = planningAskCall(
        event.input,
        await dependencies.getService(ctx).requestBriefs(),
      );
      if (planningCall.kind === "refused") return { block: true, reason: planningCall.reason };
    }
    if (toolCall.name !== "tandem") dependencies.recordTurnAction(ctx, "other");
    const reason = await coordinatorToolRefusal(toolCall, {
      researchRunning: () => dependencies.researchRunning(ctx),
      home: dependencies.getHome(ctx),
      cwd: ctx.cwd,
      userHome: homedir(),
      realpath: (path) => realpath(path),
    });
    return reason === undefined ? undefined : { block: true, reason };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ask") return undefined;
    const service = dependencies.getService(ctx);
    const planningCall = planningAskCall(event.input, await service.requestBriefs());
    if (planningCall.kind === "unmanaged") return undefined;
    if (planningCall.kind === "refused") {
      return {
        content: [{ type: "text", text: planningCall.reason }],
        details: { tandemPlanningAnswerSaved: false },
        isError: true,
      };
    }
    if (event.isError) {
      return {
        content: [
          {
            type: "text",
            text: "The saved planning question was not answered. No answer was saved; repeat this exact question.",
          },
        ],
        details: { tandemPlanningAnswerSaved: false },
        isError: true,
      };
    }
    const answer = explicitPlanningAnswer(event.details, planningCall.question);
    if (answer === undefined) {
      return {
        content: [
          {
            type: "text",
            text: "No explicit answer was saved. The planning question remains pending. A timed-out recommendation is only a default; repeat this exact question.",
          },
        ],
        details: { tandemPlanningAnswerSaved: false },
        isError: true,
      };
    }
    try {
      const saved = await service.recordRequestPlanningAnswer(
        planningCall.requestId,
        planningCall.question.id,
        answer,
      );
      const recordedAnswer = saved.record.planningInterview?.questions.find(
        (question) => question.id === planningCall.question.id,
      )?.answer;
      return {
        content: [
          {
            type: "text",
            text: `Tandem ${saved.duplicate ? "already had" : "saved"} this explicit planning answer: ${recordedAnswer?.value ?? answer.value}${recordedAnswer?.note === undefined ? "" : `; note: ${recordedAnswer.note}`}. Continue from the saved request state.`,
          },
        ],
        details: { tandemPlanningAnswerSaved: true, duplicate: saved.duplicate },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Tandem did not save this planning answer: ${error instanceof Error ? error.message : String(error)}. Read the request's current planning state before asking anything else.`,
          },
        ],
        details: { tandemPlanningAnswerSaved: false },
        isError: true,
      };
    }
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
      const outcome = await runTandemTool(
        request,
        {
          ...callDependencies(ctx, dependencies),
          showCard: (effect) => ompSessionHost(pi, () => ctx).perform(effect),
          showStatus: (effect) => ompSessionHost(pi, () => ctx).perform(effect),
        },
        signal,
      );
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
      "Inspect or control Tandem: restart, list, presentations, show, trace, messages, models, onboard, setup, open-project, find-repo, save-code-folders, self-improvement, check-tools, setup-page, create, approve, brief-show, brief-review, brief-approve, request-receipt, steer, answer, tick, pause, resume, cancel, present, presentation-open, feedback, describe, draft, publish, merge, cleanup.",
    handler: (args, ctx) =>
      runTandemCommand(
        args,
        ctx.cwd,
        callDependencies(ctx, dependencies),
        ompSessionHost(pi, () => ctx),
      ),
  });
}
