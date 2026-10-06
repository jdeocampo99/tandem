import { readNativeBundle } from "../board/native-file.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import type { CliCommandOutcome } from "./cli-commands.ts";
import { openView } from "./cli-view-actions.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

/** The palette and shortcut open one project's cached PR pane, whose strip switches PRs. */
export async function showNativePrs(context: NativeRendererContext): Promise<CliCommandOutcome> {
  const owned = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    {
      home: context.environment.home,
      sessionId: context.environment.sessionId,
      repoPath: context.environment.repo,
    },
  );
  if (owned?.endpoint.terminal !== "tern")
    throw new Error("Open this project's Tern coordinator before showing PRs");
  const index = await readNativeBundle(context.environment.home, owned.repoPath);
  const pr = Object.values(index.pullRequests)[0];
  if (pr === undefined) throw new Error("This project has no cached open pull requests yet");
  return await openView({
    ...context,
    invocation: {
      ...context.invocation,
      positionals: ["pr", `${pr.header.repo}#${pr.header.number}`],
    },
  });
}
