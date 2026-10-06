import { dirname, join } from "node:path";
import type { IsoTimestamp, WorkerReceipt } from "../contracts.ts";
import { readPrivateJson, writePrivateJson } from "../tasks/communication-persistence.ts";
import { toolName } from "./control-protocol.ts";
import type { TodoItem } from "./todos.ts";

/**
 * What a worker is doing, for display only. It sits in its own file beside the receipt so the
 * receipt's strict format never changes; recovery and steering never read it.
 */
export type WorkerActivity = Readonly<{
  readonly tool?: string;
  /** The running tool's path or command, shortened, with likely secrets left out. */
  readonly toolTarget?: string;
  readonly toolStartedAt?: IsoTimestamp;
  readonly todos?: readonly TodoItem[];
}>;

/** A tool as a harness names it, with the path or command its input names, if any. */
export type ActivityTool = Readonly<{ name: string; path?: string; command?: string }>;

export type ActivityObservation = Readonly<{
  readonly phase: WorkerReceipt["phase"];
  readonly tool?: ActivityTool | undefined;
  /** The worker's to-do list after this observation, when it changed. */
  readonly todos?: readonly TodoItem[] | undefined;
}>;

const ACTIVITY_FILE = "activity.json";
const MAX_TARGET_CHARS = 120;
const MAX_TODOS = 50;
const MAX_TODO_CHARS = 200;
const MAX_TODO_STATUS_CHARS = 32;
/** A command word from here on may carry a credential: a flag, an assignment, a URL, or a quote. */
const SECRET_SHAPED_WORD = /^-|[=@"'`]|:\/\//u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** The activity file beside a worker's receipt. */
export function workerActivityPath(receiptPath: string): string {
  return join(dirname(receiptPath), ACTIVITY_FILE);
}

/** The activity after an observation, and whether it changed and so should be written. */
export function nextWorkerActivity(
  previous: WorkerActivity,
  observation: ActivityObservation,
  now: IsoTimestamp,
): Readonly<{ activity: WorkerActivity; changed: boolean }> {
  const tool = observation.phase === "tool" ? toolName(observation.tool?.name) : undefined;
  const toolTarget =
    tool === undefined || observation.tool === undefined
      ? undefined
      : displayTarget(observation.tool);
  const sameTool = previous.tool === tool && previous.toolTarget === toolTarget;
  const todos = observation.todos === undefined ? previous.todos : displayTodos(observation.todos);
  const activity: WorkerActivity = {
    ...(tool === undefined
      ? {}
      : {
          tool,
          ...(toolTarget === undefined ? {} : { toolTarget }),
          toolStartedAt: (sameTool ? previous.toolStartedAt : undefined) ?? now,
        }),
    ...(todos === undefined ? {} : { todos }),
  };
  return { activity, changed: JSON.stringify(activity) !== JSON.stringify(previous) };
}

/** The activity a file holds, keeping only well-formed fields; anything else is no activity. */
export function parseWorkerActivity(value: unknown): WorkerActivity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { tool, toolTarget, toolStartedAt, todos } = value as Record<string, unknown>;
  const items = Array.isArray(todos)
    ? todos.filter(
        (item): item is TodoItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as TodoItem).content === "string" &&
          typeof (item as TodoItem).status === "string",
      )
    : undefined;
  return {
    ...(typeof tool === "string" ? { tool } : {}),
    ...(typeof toolTarget === "string" ? { toolTarget } : {}),
    ...(typeof toolStartedAt === "string" ? { toolStartedAt } : {}),
    ...(items === undefined ? {} : { todos: items }),
  };
}

/** Never throws: a missing or unreadable file is no activity. */
export async function readWorkerActivity(receiptPath: string): Promise<WorkerActivity | undefined> {
  return readPrivateJson(workerActivityPath(receiptPath)).then(
    parseWorkerActivity,
    () => undefined,
  );
}

export async function writeWorkerActivity(
  receiptPath: string,
  activity: WorkerActivity,
): Promise<void> {
  await writePrivateJson(workerActivityPath(receiptPath), activity);
}

/** A path keeps its end, a URL its host and path, and a command its leading plain words. */
function displayTarget(tool: ActivityTool): string | undefined {
  const path = oneLine(tool.path ?? "");
  if (path.length > 0) {
    const shown = URL_SCHEME.test(path) ? urlWithoutSecrets(path) : path;
    return shown.length === 0 ? undefined : keepEnd(shown, MAX_TARGET_CHARS);
  }
  const words = oneLine(tool.command ?? "").split(" ");
  const end = words.findIndex((word) => SECRET_SHAPED_WORD.test(word));
  const command = words.slice(0, end === -1 ? undefined : end).join(" ");
  return command.length === 0 ? undefined : keepStart(command, MAX_TARGET_CHARS);
}

function urlWithoutSecrets(text: string): string {
  if (!URL.canParse(text)) return "";
  const url = new URL(text);
  return `${url.host}${url.pathname}`;
}

function displayTodos(items: readonly TodoItem[]): readonly TodoItem[] {
  return items.slice(0, MAX_TODOS).flatMap((item) => {
    const content = keepStart(oneLine(item.content), MAX_TODO_CHARS);
    const status = keepStart(oneLine(item.status), MAX_TODO_STATUS_CHARS);
    return content.length === 0 || status.length === 0 ? [] : [{ content, status }];
  });
}

function oneLine(text: string): string {
  return text.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
}

function keepStart(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : text;
}

function keepEnd(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `…${chars.slice(-(maxChars - 1)).join("")}` : text;
}
