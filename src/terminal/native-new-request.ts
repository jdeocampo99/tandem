import { findRunningCoordinator } from "../coordinator/ownership.ts";
import type { CoordinatorRecord } from "../coordinator/record.ts";
import type { CliCommandOutcome } from "./cli-commands.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

async function ownedCoordinator(context: NativeRendererContext): Promise<CoordinatorRecord> {
  const owned = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    {
      home: context.environment.home,
      sessionId: context.environment.sessionId,
      repoPath: context.environment.repo,
    },
  );
  if (owned === undefined)
    throw new Error("Open this project's coordinator before starting a request");
  return owned;
}

/** Intake stays in the coordinator conversation, where scope and approval are established. */
export async function newNativeRequest(context: NativeRendererContext): Promise<CliCommandOutcome> {
  const owned = await ownedCoordinator(context);
  const target = {
    sessionId: owned.endpoint.sessionId,
    cwd: owned.worktree.path,
    paneId: owned.endpoint.paneId,
  };
  if (!(await context.capabilities.terminal.focusAgent(target))) {
    throw new Error("The coordinator could not be focused; the new request was not sent");
  }
  const current = await ownedCoordinator(context);
  if (
    JSON.stringify(current.endpoint) !== JSON.stringify(owned.endpoint) ||
    current.worktree.leaseId !== owned.worktree.leaseId
  ) {
    throw new Error("The coordinator changed; the new request was not sent");
  }
  await context.capabilities.terminal.promptAgent({
    ...target,
    text: "I'd like to start a new request. Ask me what I want to change, then help me plan it in this conversation.",
  });
  return { value: { focused: true, prompted: true } };
}
