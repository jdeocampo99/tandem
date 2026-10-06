import { markNativeAlertsRead, nativeAlertCounts } from "../board/native-alerts.ts";
import { readNativeBundle } from "../board/native-file.ts";
import { nativeDetailPath, nativeViewsPath } from "../board/snapshot.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import { maybeShowCatchUp, recordNativeVisibility } from "../memory/native-visits.ts";
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
/** A focus event is a project entry only inside its exact recorded native session. */
async function lifecycle(context: NativeRendererContext, action: "entry" | "away" | "visible") {
  const current = await owner(context);
  if (current.endpoint.terminalSessionId === undefined)
    throw new Error("Project visibility needs its recorded native session identity");
  const panes = await context.capabilities.terminal.listPanes({
    sessionId: current.endpoint.sessionId,
    cwd: current.worktree.path,
    complete: true,
  });
  const origin = panes.find((pane) => pane.paneId === context.origin.paneId);
  if (!origin) throw new Error("Originating pane disappeared");
  await context.capabilities.terminal.inspect({
    endpoint: {
      ...current.endpoint,
      paneId: origin.paneId,
      tabId: origin.tabId,
      workspaceId: origin.workspaceId,
    },
    cwd: current.worktree.path,
  });
  if (action !== "entry") {
    const model = await readNativeBundle(context.environment.home, current.repoPath);
    await recordNativeVisibility({
      home: context.environment.home,
      project: current.repoPath,
      now: new Date().toISOString(),
      heartbeat: action === "visible",
      ...(model.changeSignature === undefined ? {} : { signature: model.changeSignature }),
    });
    return { value: { visible: action === "visible" } };
  }
  const helper = current.endpoint.notificationPane;
  if (context.origin.paneId === helper?.paneId) {
    if (helper.paneId === current.endpoint.paneId)
      throw new Error("Alert helper must be independent of its coordinator");
    await context.capabilities.terminal.inspect({
      endpoint: { ...current.endpoint, ...helper },
      cwd: current.worktree.path,
    });
    const cursor = await nativeAlertCounts(context.environment.home, current.repoPath);
    const focused = await context.capabilities.terminal.focusAgent({
      sessionId: current.endpoint.sessionId,
      cwd: current.worktree.path,
      paneId: current.endpoint.paneId,
      origin: context.origin,
      originCoordinator: current.endpoint,
      home: context.environment.home,
    });
    if (!focused) throw new Error("Tern could not focus the alert's exact project coordinator");
    await markNativeAlertsRead(context.environment.home, current.repoPath, cursor.delivered);
  }
  await maybeShowCatchUp(context.capabilities.terminal, {
    home: context.environment.home,
    record: current,
    ...(context.origin.windowId === undefined ? {} : { windowId: context.origin.windowId }),
  }).catch(() => false);
  return { value: { entered: true } };
}

export async function nativeProject(context: NativeRendererContext) {
  if (context.input.kind !== "project") throw new Error("Expected project navigation");
  if (
    context.input.target === "entry" ||
    context.input.target === "away" ||
    context.input.target === "visible"
  )
    return lifecycle(context, context.input.target);
  const current = await owner(context);
  const model = await readNativeBundle(context.environment.home, current.repoPath);
  if (
    Math.abs(Date.now() - Date.parse(model.writtenAt)) > 10000 ||
    !Number.isFinite(Date.parse(model.writtenAt))
  )
    throw new Error("Project switcher is stale; wait for the coordinator snapshot");
  const currentProjects = model.projects.filter((project) => project.current);
  if (currentProjects.length !== 1 || currentProjects[0]?.repoPath !== current.repoPath)
    throw new Error("Project switcher has no unique originating project");
  const index = model.projects.findIndex((project) => project.current);
  const target = context.input.target;
  const number =
    typeof target === "object"
      ? model.projects.findIndex((project) => project.repoPath === target.repoPath)
      : typeof target === "number"
        ? target - 1
        : (index + (target === "prev" ? -1 : 1) + model.projects.length) % model.projects.length;
  if (
    typeof target === "object" &&
    model.projects.filter((project) => project.repoPath === target.repoPath).length !== 1
  )
    throw new Error("Project identity is missing or ambiguous");
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
  if (destination.repoPath !== current.repoPath)
    await recordNativeVisibility({
      home: context.environment.home,
      project: current.repoPath,
      now: new Date().toISOString(),
      ...(model.changeSignature === undefined ? {} : { signature: model.changeSignature }),
    }).catch(() => {});
  await maybeShowCatchUp(context.capabilities.terminal, {
    home: context.environment.home,
    record: destination,
    ...(context.origin.windowId === undefined ? {} : { windowId: context.origin.windowId }),
  }).catch(() => false);
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
  const alerts =
    view.kind === "inbox"
      ? await nativeAlertCounts(context.environment.home, current.repoPath)
      : undefined;
  const result = await context.capabilities.terminal.openView({
    coordinator: current.endpoint,
    cwd: current.worktree.path,
    home: context.environment.home,
    origin: context.origin,
    view,
  });
  if (!result.opened) throw new Error(result.warnings.join("; "));
  if (alerts)
    await markNativeAlertsRead(context.environment.home, current.repoPath, alerts.delivered);
  return { value: result };
}
