import { findRunningCoordinator } from "../coordinator/ownership.ts";
import type { NativeRendererHandler } from "./native-renderers.ts";

/** The palette opens a read-only task index; selection invokes the ordinary native open action. */
export const nativeOpenTask: NativeRendererHandler = async (context) => {
  if (context.input.kind !== "open-task") throw new Error("Expected task picker");
  const owner = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    {
      home: context.environment.home,
      sessionId: context.environment.sessionId,
      repoPath: context.environment.repo,
    },
  );
  if (owner?.endpoint.terminal !== "tern")
    throw new Error("Open this project's Tern coordinator before choosing a task");
  const result = await context.capabilities.terminal.openView({
    coordinator: owner.endpoint,
    cwd: owner.worktree.path,
    home: context.environment.home,
    origin: context.origin,
    view: { kind: "task-picker" },
  });
  if (!result.opened)
    throw new Error(result.warnings.join("; ") || "The task picker could not open");
  return { value: result };
};
