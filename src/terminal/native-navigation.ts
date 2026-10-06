import { readNativeBundle } from "../board/native-file.ts";
import { nativeDetailPath, nativeViewsPath } from "../board/snapshot.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import type { NativeRendererContext } from "./native-renderers.ts";

async function owner(
  context: NativeRendererContext,
  repo = context.environment.repo,
  session = context.environment.sessionId,
) {
  const record = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    { home: context.environment.home, sessionId: session, repoPath: repo },
  );
  if (record?.endpoint.terminal !== "tern")
    throw new Error("Open this project's Tern coordinator before navigating");
  return record;
}
export async function nativeProject(context: NativeRendererContext) {
  if (context.input.kind !== "project") throw new Error("Expected project navigation");
  const current = await owner(context);
  const model = await readNativeBundle(context.environment.home, current.repoPath);
  if (
    Date.now() - Date.parse(model.writtenAt) > 10000 ||
    !Number.isFinite(Date.parse(model.writtenAt))
  )
    throw new Error("Project switcher is stale; wait for the coordinator snapshot");
  const index = model.projects.findIndex((project) => project.current);
  const target = context.input.target;
  const number =
    typeof target === "number"
      ? target - 1
      : (index + (target === "prev" ? -1 : 1) + model.projects.length) % model.projects.length;
  const project = model.projects[number];
  if (!project || project.offline || !project.sessionId)
    throw new Error("That project is offline or unavailable");
  const destination = await owner(context, project.repoPath, project.sessionId);
  const focused = await context.capabilities.terminal.focusAgent({
    sessionId: destination.endpoint.sessionId,
    cwd: destination.worktree.path,
    paneId: destination.endpoint.paneId,
    origin: context.origin,
    originCoordinator: current.endpoint,
    home: context.environment.home,
  });
  if (!focused) throw new Error("Tern could not focus the exact project coordinator");
  return { value: { focused: true, project: project.repoPath } };
}

/** Native files select a known view only; arbitrary paths cannot grant block or terminal ownership. */
export async function nativeViewFile(context: NativeRendererContext) {
  if (context.input.kind !== "view-file") throw new Error("Expected view file navigation");
  const current = await owner(context);
  const root = nativeViewsPath(context.environment.home, current.repoPath);
  const [path, action] = context.input.path.split("#");
  if (path === root && action === "open-project") {
    await context.capabilities.terminal.promptAgent({
      sessionId: current.endpoint.sessionId,
      cwd: current.worktree.path,
      paneId: current.endpoint.paneId,
      text: "Help me open another project in Tandem.",
    });
    return { value: { delivered: true } };
  }
  let view: Parameters<typeof context.capabilities.terminal.openView>[0]["view"];
  if (path === root) {
    if (action === "inbox") view = { kind: "inbox" };
    else if (action === "orchestrator" || action === undefined) view = { kind: "orchestrator" };
    else throw new Error("Unknown native navigation action");
  } else {
    if (action !== undefined) throw new Error("Detail files do not accept navigation actions");
    const model = await readNativeBundle(context.environment.home, current.repoPath);
    const task = Object.entries(model.tasks).find(
      ([, entry]) =>
        nativeDetailPath(context.environment.home, current.repoPath, entry.detailFile) === path,
    );
    const brief = Object.entries(model.briefs).find(
      ([, entry]) =>
        nativeDetailPath(context.environment.home, current.repoPath, entry.detailFile) === path,
    );
    const pr = Object.values(model.pullRequests).find(
      (entry) =>
        nativeDetailPath(context.environment.home, current.repoPath, entry.detailFile) === path,
    );
    if (task) view = { kind: "task", taskId: task[0] };
    else if (brief) view = { kind: "brief", requestId: brief[0] };
    else if (pr?.header.taskId) view = { kind: "pr", taskId: pr.header.taskId };
    else throw new Error("This file is not a published view for the originating project");
  }
  const result = await context.capabilities.terminal.openView({
    coordinator: current.endpoint,
    cwd: current.worktree.path,
    home: context.environment.home,
    origin: context.origin,
    view,
  });
  if (!result.opened) throw new Error(result.warnings.join("; "));
  return { value: result };
}
