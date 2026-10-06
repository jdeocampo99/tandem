import { readNativeBundle } from "../board/native-file.ts";
import type { CliCommandOutcome } from "./cli-commands.ts";
import { openView } from "./cli-view-actions.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

/** The palette and shortcut open one project's cached PR pane, whose strip switches PRs. */
export async function showNativePrs(context: NativeRendererContext): Promise<CliCommandOutcome> {
  const index = await readNativeBundle(context.environment.home, context.environment.repo);
  const pr = Object.values(index.pullRequests).find((entry) => entry.header.taskId !== undefined);
  if (pr?.header.taskId === undefined)
    throw new Error("This project has no cached open pull requests yet");
  return await openView({
    ...context,
    invocation: { ...context.invocation, positionals: ["pr", pr.header.taskId] },
  });
}
