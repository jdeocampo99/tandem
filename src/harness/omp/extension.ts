import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { processEnvironmentSnapshot } from "../../config/environment.ts";
import type { CoordinatorSession } from "../../session/coordinator.ts";
import type { CoordinatorMessage } from "../../session/onboarding-guide.ts";
import { promptRoutingConfig } from "../../session/prompt-routing.ts";
import { replyUsage } from "../../workers/terminal.ts";
import {
  type BoundCoordinator,
  bindCoordinator,
  type CoordinatorOptions,
} from "../coordinator-session.ts";
import { ompSessionHost, ompToolCall } from "./host.ts";
import { registerTandemOmp } from "./registration.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The status line only needs the tool's kind, so its arguments are not classified. */
function statusToolCall(event: Readonly<{ toolCallId: string; toolName: string }>) {
  return ompToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: {} });
}
function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function coordinatorMessage(message: unknown): CoordinatorMessage {
  const record = recordValue(message);
  const role = typeof record?.role === "string" ? record.role : "unknown";
  const content = record?.content;
  const plainContent =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((block) => {
            const value = recordValue(block);
            if (value === undefined || typeof value.type !== "string") return [];
            return [
              {
                type: value.type,
                ...(typeof value.text === "string" ? { text: value.text } : {}),
              },
            ];
          })
        : [];
  const retryRecovery = recordValue(record?.retryRecovery);
  return {
    role,
    content: plainContent,
    ...(record?.synthetic === true ? { synthetic: true } : {}),
    ...(retryRecovery?.status === "superseded" ? { superseded: true } : {}),
  };
}

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: CoordinatorOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const environmentSnapshot = processEnvironmentSnapshot(options.processEnvironment);
    let latestContext: ExtensionContext;
    let bound: BoundCoordinator | undefined;

    /** The session is built from the first context, since its environment depends on the cwd. */
    const bind = (ctx: ExtensionContext): BoundCoordinator => {
      const currentContext = (): ExtensionContext => latestContext;
      return bindCoordinator(options, {
        host: ompSessionHost(pi, currentContext),
        timers: {
          every: (ms, run) => {
            const timerContext = currentContext();
            const timer = timerContext.setInterval(run, ms);
            return () => timerContext.clearTimer(timer);
          },
          after: (ms, run) => {
            const timerContext = currentContext();
            const timer = timerContext.setTimeout(run, ms);
            return () => timerContext.clearTimer(timer);
          },
        },
        logError: (message, error) => pi.logger.error(message, { error: errorMessage(error) }),
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
      });
    };
    const coordinator = (ctx: ExtensionContext): BoundCoordinator => {
      latestContext = ctx;
      bound ??= bind(ctx);
      return bound;
    };
    const session = (ctx: ExtensionContext): CoordinatorSession => coordinator(ctx).session;

    registerTandemOmp(pi, {
      getService: (ctx) => session(ctx).service(),
      getHome: (ctx) => coordinator(ctx).environment.home,
      getRepo: (ctx) => coordinator(ctx).environment.repo,
      promptRouting: promptRoutingConfig(environmentSnapshot),
      reconcile: (ctx, runTick) => session(ctx).reconcile(runTick),
      postAction: (ctx) => session(ctx).reconcile(false),
      recordTurnAction: (ctx, action) => session(ctx).recordTurnAction(action),
      userPrompt: (ctx) => session(ctx).userPrompt(),
      closeThread: (ctx) => session(ctx).closeThread(),
      researchRunning: (ctx) => session(ctx).researchRunning(),
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const { systemContext } = await session(ctx).agentStart();
      return { systemPrompt: [...event.systemPrompt, ...systemContext] };
    });
    pi.on("session_start", (_event, ctx) => session(ctx).sessionStart());
    pi.on("turn_start", (_event, ctx) => session(ctx).turnStart());
    pi.on("tool_execution_start", (event, ctx) => session(ctx).toolStart(statusToolCall(event)));
    pi.on("tool_execution_end", (event, ctx) => session(ctx).toolEnd(statusToolCall(event)));
    pi.on("turn_end", (event, ctx) => session(ctx).turnEnd(replyUsage(event.message)));
    pi.on("agent_end", (event, ctx) =>
      session(ctx).agentEnd(
        event.willContinue === true,
        () => event.messages?.map((message) => coordinatorMessage(message)) ?? [],
      ),
    );
    pi.on("session.compacting", async (_event, ctx) => {
      const { context, preserve } = await session(ctx).compacting();
      return { context: [...context], preserveData: { ...preserve } };
    });
    pi.on("session_compact", (_event, ctx) => session(ctx).compacted());
    pi.on("session_shutdown", async (_event, ctx) => {
      if (bound === undefined) return;
      latestContext = ctx;
      await bound.session.shutdown();
    });
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
