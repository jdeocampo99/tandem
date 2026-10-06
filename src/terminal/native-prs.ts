import { readFile } from "node:fs/promises";
import { z } from "zod";
import { nativeViewsPath } from "../board/snapshot.ts";
import { openView } from "./cli-view-actions.ts";
import type { CliCommandOutcome } from "./cli-commands.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

const prIndex = z.object({
  version: z.literal(1),
  kind: z.literal("panel"),
  revision: z.string(),
  model: z.object({
    project: z.string(),
    pullRequests: z.record(
      z.object({
        header: z.object({ number: z.number().int().positive(), taskId: z.string().optional() }),
      }),
    ),
  }),
});

/** The palette and shortcut open one project's cached PR pane, whose strip switches PRs. */
export async function showNativePrs(context: NativeRendererContext): Promise<CliCommandOutcome> {
  const path = nativeViewsPath(context.environment.home, context.environment.repo);
  const index = prIndex.parse(JSON.parse(await readFile(path, "utf8")));
  if (index.model.project !== context.environment.repo)
    throw new Error("The PR index does not belong to the selected project");
  const pr = Object.values(index.model.pullRequests)
    .filter((entry) => entry.header.taskId !== undefined)
    .sort((a, b) => b.header.number - a.header.number)[0];
  if (pr?.header.taskId === undefined)
    throw new Error("This project has no cached open pull requests yet");
  return await openView({
    ...context,
    invocation: { ...context.invocation, positionals: ["pr", pr.header.taskId] },
  });
}
