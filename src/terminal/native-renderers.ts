import { isAbsolute, resolve } from "node:path";
import { type CliInvocation, CliUsageError, pathText, text } from "./cli-arguments.ts";
import type { CliCommandContext, CliCommandOutcome } from "./cli-commands.ts";
import { validateNativeContext, viewOriginFrom } from "./cli-view-context.ts";
import { nativeProject, nativeViewFile } from "./native-navigation.ts";
import { newNativeRequest } from "./native-new-request.ts";
import { showNativePrs } from "./native-prs.ts";
import { nativeBoard, nativeUsage } from "./native-screens.ts";
import { nativeOpenTask } from "./native-task-picker.ts";

export type NativeRendererCommand =
  | "board"
  | "prs"
  | "usage"
  | "new-request"
  | "open-task"
  | "project"
  | "view-file";

export type NativeRendererInput =
  | Readonly<{ kind: "board" | "prs" | "usage" | "new-request" | "open-task" }>
  | Readonly<{
      kind: "project";
      target:
        | number
        | "prev"
        | "next"
        | "entry"
        | "away"
        | "visible"
        | Readonly<{ repoPath: string }>;
    }>
  | Readonly<{ kind: "view-file"; path: string }>;

export type NativeRendererContext = Omit<CliCommandContext, "invocation"> &
  Readonly<{
    invocation: CliInvocation & Readonly<{ command: NativeRendererCommand }>;
    input: NativeRendererInput;
    origin: Readonly<{ paneId: string; cwd: string; windowId?: string }>;
  }>;

export type NativeRendererHandler = (context: NativeRendererContext) => Promise<CliCommandOutcome>;

export type NativeRendererHandlers = Readonly<Record<NativeRendererCommand, NativeRendererHandler>>;

/** The single implementation registration point for the wave-2 renderer commands. */
export const nativeRendererHandlers: NativeRendererHandlers = {
  board: nativeBoard,
  prs: showNativePrs,
  usage: nativeUsage,
  "new-request": newNativeRequest,
  "open-task": nativeOpenTask,
  project: nativeProject,
  "view-file": nativeViewFile,
};

export function isNativeRendererCommand(command: string): command is NativeRendererCommand {
  return Object.hasOwn(nativeRendererHandlers, command);
}

const ACTION_COMMANDS = [
  "open",
  "brief-comment",
  "brief-request-changes",
  "brief-approve",
  "pr-comment",
  "restart",
  "steer",
  "review-submit",
] as const;

export const nativeCommandNames: readonly string[] = [
  ...ACTION_COMMANDS,
  ...Object.keys(nativeRendererHandlers),
];

export function isNativeCommand(command: string): boolean {
  return nativeCommandNames.includes(command);
}

function rendererInput(
  invocation: CliInvocation & Readonly<{ command: NativeRendererCommand }>,
  cwd: string,
): NativeRendererInput {
  const kind = invocation.command;
  if (kind === "project") {
    const target = text(invocation.positionals[0], "project target");
    if (
      target === "prev" ||
      target === "next" ||
      target === "entry" ||
      target === "away" ||
      target === "visible"
    )
      return { kind, target };
    if (target.startsWith("repo:") && isAbsolute(target.slice(5)))
      return { kind, target: { repoPath: target.slice(5) } };
    if (!/^[1-9]$/u.test(target)) {
      throw new CliUsageError(
        "native project requires 1..9, prev, next, repo:ABSOLUTE_PATH, entry, away, or visible",
      );
    }
    return { kind, target: Number(target) };
  }
  if (kind === "view-file") {
    return { kind, path: resolve(cwd, pathText(invocation.positionals[0], "view file")) };
  }
  return { kind };
}

/** Dispatches once after parsing origin and command input, without starting a service itself. */
export async function runNativeRenderer(context: CliCommandContext): Promise<CliCommandOutcome> {
  const command = context.invocation.command;
  if (!isNativeRendererCommand(command)) throw new CliUsageError("Unknown native renderer command");
  validateNativeContext(context.invocation);
  const suppliedOrigin = viewOriginFrom(context.invocation);
  const origin = {
    paneId: text(suppliedOrigin?.paneId, "pane"),
    cwd: pathText(suppliedOrigin?.cwd, "cwd"),
    ...(suppliedOrigin?.windowId === undefined ? {} : { windowId: suppliedOrigin.windowId }),
  };
  const invocation = { ...context.invocation, command };
  const handler =
    context.capabilities.nativeRendererHandlers?.[command] ?? nativeRendererHandlers[command];
  return handler({ ...context, invocation, input: rendererInput(invocation, origin.cwd), origin });
}
