import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { processEnvironmentSnapshot } from "../../config/environment.ts";
import { appendDiagnosticEvent } from "../../runtime/diagnostics.ts";
import { runTandemTool, type TandemCallDependencies } from "../../session/actions.ts";
import type { SessionDeps } from "../../session/events.ts";
import type { CoordinatorMessage } from "../../session/onboarding-guide.ts";
import {
  type ChoiceConfirmation,
  promptRoutingConfig,
  routeUserPrompt,
} from "../../session/prompt-routing.ts";
import { coordinatorToolRefusal } from "../../session/tool-guard.ts";
import { tandemRequestSchema } from "../../session/tools.ts";
import { bindCoordinator, type CoordinatorOptions } from "../coordinator-session.ts";
import { type ClaudeCodePane, claudeCodeToolCall, claudeCodeUsage } from "./host.ts";
import type {
  HookEventType,
  HookReply,
  SidecarEvent,
  WireToolSpec,
} from "./plugins/tandem/hooks/protocol.ts";
import { coordinatorTools, TANDEM_TOOL } from "./tool-specs.ts";

/** The events a session answers; the sidecar itself handles `shutdown` and `askAnswer`. */
export type SessionHookEvent = Extract<SidecarEvent, { type: Exclude<HookEventType, "shutdown"> }>;

/** What the sidecar drives: one core session, answering each hook event. */
export type SessionBinding = Readonly<{
  /** The tools the mod registers for this session. */
  tools: readonly WireToolSpec[];
  handle(event: SessionHookEvent): Promise<HookReply>;
  shutdown(): Promise<void>;
}>;

const DONE: HookReply = { type: "done" };
const NO_TOOL_CONTEXT: HookReply = { type: "toolContext", context: [] };

/**
 * The one exchange a finished Claude Code run is made of, as the messages the core reads at its
 * end: Claude Code shows a mod no message list, only the prompt the run began with and its final
 * answer. Without the prompt there is nothing for the setup page's wait to match.
 */
export function turnMessages(
  end: Extract<SidecarEvent, { type: "agentEnd" }>,
): readonly CoordinatorMessage[] {
  if (end.prompt === undefined) return [];
  return [
    { role: "user", content: end.prompt },
    ...(end.answer === undefined ? [] : [{ role: "assistant", content: end.answer }]),
  ];
}

/**
 * The coordinator's `CoordinatorSession` driven by Claude Code events, mirroring the OMP
 * extension's wiring in src/harness/omp/extension.ts and registration.ts.
 */
export function claudeCodeCoordinator(
  pane: ClaudeCodePane,
  harness: Pick<SessionDeps, "timers" | "logError"> & Readonly<{ cwd: string; sessionId: string }>,
  options: CoordinatorOptions = {},
): SessionBinding {
  const { environment, session } = bindCoordinator(options, { ...harness, host: pane.host });
  const routing = promptRoutingConfig(processEnvironmentSnapshot(options.processEnvironment));
  const confirmation: ChoiceConfirmation = {};
  const calls: TandemCallDependencies = {
    service: () => session.service(),
    recordTurnAction: (action) => session.recordTurnAction(action),
    confirm: pane.host.confirm,
    reconcile: () => session.reconcile(false),
    postAction: () => session.reconcile(false),
    closeThread: () => session.closeThread(),
  };

  async function handle(event: SessionHookEvent): Promise<HookReply> {
    pane.observe(event);
    switch (event.type) {
      case "sessionStart":
        await session.sessionStart();
        return DONE;
      case "userPrompt": {
        const { handled } = await routeUserPrompt(event, {
          confirmation,
          config: routing,
          service: () => session.service(),
          repoPath: () => environment.repo,
          host: pane.host,
          confirm: pane.host.confirm,
          diagnostics: (entry) => appendDiagnosticEvent(environment.home, entry),
        });
        if (!handled && event.interactive) session.userPrompt();
        return { type: "promptRoute", handled };
      }
      case "agentStart": {
        const { systemContext } = await session.agentStart();
        return { type: "turnContext", system: systemContext, context: pane.takeNextTurn() };
      }
      case "turnStart":
        session.turnStart();
        return DONE;
      // The coordinator's host reports no streaming progress, so nothing watches for stalls.
      case "streaming":
        return DONE;
      case "toolCall": {
        session.recordTurnAction("other");
        const reason = await coordinatorToolRefusal(claudeCodeToolCall(event.call), {
          researchRunning: () => session.researchRunning(),
          home: environment.home,
          cwd: harness.cwd,
          userHome: homedir(),
          realpath: (path) => realpath(path),
        });
        return reason === undefined
          ? { type: "toolDecision", block: false }
          : { type: "toolDecision", block: true, reason };
      }
      case "pluginTool": {
        if (event.name !== TANDEM_TOOL) {
          return { type: "toolResult", text: `no tool named ${event.name}`, isError: true };
        }
        const request = tandemRequestSchema.safeParse(event.input);
        if (!request.success) {
          return { type: "toolResult", text: request.error.message, isError: true };
        }
        const outcome = await runTandemTool(request.data.request, calls, undefined);
        return { type: "toolResult", text: outcome.text, isError: outcome.isError };
      }
      case "toolStart":
        session.toolStart(claudeCodeToolCall(event.call));
        return DONE;
      case "toolEnd":
        session.toolEnd(claudeCodeToolCall(event.call));
        return NO_TOOL_CONTEXT;
      case "turnEnd":
        await session.turnEnd(event.usage === undefined ? undefined : claudeCodeUsage(event.usage));
        return DONE;
      case "agentEnd":
        await session.agentEnd(false, () => turnMessages(event));
        return DONE;
      case "stopRequested":
        return { type: "stop" };
      case "promptEdit":
        return { type: "editDecision", allowed: true };
      case "compacting": {
        const { context } = await session.compacting();
        return { type: "compaction", instructions: context.join("\n\n") };
      }
      case "compacted":
        await session.compacted();
        return DONE;
    }
  }

  return { tools: coordinatorTools(), handle, shutdown: () => session.shutdown() };
}
