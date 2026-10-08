import { createHash } from "node:crypto";
import { isBoardView } from "../board/view.ts";
import type { DiagnosticValue } from "../runtime/diagnostics.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import { executeTandemAction, type TandemAction } from "./actions.ts";
import type { PromptRoutingDependencies } from "./prompt-routing.ts";
import { ACTION_RESULT_MAX_CHARS, compactText, summarizeTandemActionValue } from "./summary.ts";

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

export async function recordDiagnostic(
  deps: PromptRoutingDependencies,
  event: string,
  details: Record<string, DiagnosticValue>,
  usage?: UsageRecord,
): Promise<void> {
  try {
    await deps.diagnostics({ event, details, ...(usage === undefined ? {} : { usage }) });
  } catch {
    // Diagnostics are best effort and must never alter prompt handling.
  }
}

export async function deliverReply(
  deps: PromptRoutingDependencies,
  text: string,
  details: Record<string, DiagnosticValue>,
): Promise<void> {
  await deps.host.perform({
    type: "deliver",
    source: "prompt-route",
    text,
    details,
    timing: "nextTurn",
    triggerTurn: false,
  });
}

/**
 * Runs one routed action and shows its result, or its failure, as the turn's reply. Every route
 * that skips the coordinator ends here, so they all display and record outcomes the same way.
 */
export async function dispatchRoutedAction(
  prompt: string,
  action: TandemAction,
  deps: PromptRoutingDependencies,
  options: Readonly<{
    readonly details?: Record<string, DiagnosticValue>;
    readonly confirmedInConversation?: boolean;
  }> = {},
): Promise<void> {
  const shared = { promptHash: promptHash(prompt), action: action.action };
  try {
    const result = await executeTandemAction(action, deps.service(), {
      confirm: deps.confirm,
      confirmedInConversation: options.confirmedInConversation ?? false,
    });
    const details = { ...shared, ...options.details };
    const text = summarizeTandemActionValue(result.action, result.value);
    if (result.action === "board" && isBoardView(result.value)) {
      await deps.host.perform({
        type: "showStatus",
        view: result.value,
        text,
        details,
        timing: "nextTurn",
        triggerTurn: false,
      });
    } else {
      await deliverReply(deps, text, details);
    }
    await recordDiagnostic(deps, "prompt-route-dispatched", { ...shared, ...options.details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `Tandem ${action.action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`;
    await deliverReply(deps, output, { ...shared, error: "action-failed" });
    await recordDiagnostic(deps, "prompt-route-failed", { ...shared, error: "action-failed" });
  }
}

export async function recordFallback(
  prompt: string,
  deps: PromptRoutingDependencies,
  reason: string,
): Promise<false> {
  await recordDiagnostic(deps, "prompt-route-fallback", { promptHash: promptHash(prompt), reason });
  return false;
}

export async function recordRouteEvaluation(
  prompt: string,
  deps: PromptRoutingDependencies,
  evaluation: Readonly<{ reason: string; durationMs: number; usage?: UsageRecord }>,
  details: Record<string, DiagnosticValue>,
): Promise<void> {
  await recordDiagnostic(
    deps,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: "jev",
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      ...details,
    },
    evaluation.usage,
  );
}

/** A confirmation lasts one message; anything except exact y/n continues as a new prompt. */
export async function routeConfirmation(
  prompt: string,
  deps: PromptRoutingDependencies,
): Promise<boolean> {
  const pending = deps.confirmation?.pending;
  if (deps.confirmation === undefined || pending === undefined) return false;
  deps.confirmation.pending = undefined;
  if (prompt === "y") {
    await dispatchRoutedAction(prompt, pending.action, deps, { confirmedInConversation: true });
    return true;
  }
  if (prompt !== "n") return false;
  await deliverReply(deps, "Okay, I didn't do that.", {
    promptHash: promptHash(prompt),
    action: pending.action.action,
    declined: true,
  });
  await recordDiagnostic(deps, "prompt-route-declined", {
    promptHash: promptHash(prompt),
    action: pending.action.action,
  });
  return true;
}
