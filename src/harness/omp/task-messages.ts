import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TaskMessagesPlacement } from "../../session/events.ts";
import {
  formatTaskMessages,
  isRecord,
  parseTaskMessageBatch,
  TASK_COMMUNICATION_MARKER,
  type TaskMessageBatch,
} from "../../tasks/communication-protocol.ts";

export type Marker = Readonly<{
  readonly raw: string;
  readonly prefix: string;
  readonly batch: TaskMessageBatch;
}>;

export type MarkerInsertion = { inserted: boolean };

function extractText(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    texts.push(block.text);
  }
  return texts;
}

export function markersFromText(text: string): readonly Marker[] {
  const markers: Marker[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const markerStart = line.indexOf(`${TASK_COMMUNICATION_MARKER} `);
    if (markerStart < 0) continue;
    const prefix = line.slice(0, markerStart);
    if (prefix.trim().length !== 0 && prefix.trim() !== "-") continue;
    const payload = line.slice(markerStart + TASK_COMMUNICATION_MARKER.length + 1);
    try {
      const parsed = JSON.parse(payload) as unknown;
      const batch = parseTaskMessageBatch(parsed);
      markers.push({ raw: line, prefix, batch });
    } catch {
      // An unrecognized marker is not proof of a provider-bound message.
    }
  }
  return markers;
}

export function markersFromMessages(messages: readonly AgentMessage[]): readonly Marker[] {
  const markers: Marker[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") continue;
    for (const text of extractText(message.content)) markers.push(...markersFromText(text));
  }
  return markers;
}

export function collapseTextMarkers(
  text: string,
  taskId: string,
  replacement: string,
  insertion: MarkerInsertion,
): Readonly<{ text: string; found: boolean }> {
  let found = false;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = markersFromText(line).find((candidate) => candidate.batch.taskId === taskId);
    if (marker === undefined) {
      lines.push(line);
      continue;
    }
    found = true;
    if (!insertion.inserted) {
      lines.push(`${marker.prefix}${replacement}`);
      insertion.inserted = true;
    }
  }
  return { text: lines.join("\n"), found };
}

export function collapseMessageMarkers(
  message: AgentMessage,
  taskId: string,
  replacement: string,
  insertion: MarkerInsertion,
): Readonly<{ message?: AgentMessage; found: boolean }> {
  if (!isRecord(message) || message.role !== "user") return { message, found: false };
  if (typeof message.content === "string") {
    const collapsed = collapseTextMarkers(message.content, taskId, replacement, insertion);
    if (!collapsed.found) return { message, found: false };
    return collapsed.text.trim().length === 0
      ? { found: true }
      : { message: { ...message, content: collapsed.text } as AgentMessage, found: true };
  }
  if (!Array.isArray(message.content)) return { message, found: false };
  let found = false;
  const content = message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return [block];
    }
    const collapsed = collapseTextMarkers(block.text, taskId, replacement, insertion);
    if (!collapsed.found) return [block];
    found = true;
    if (collapsed.text.trim().length === 0) return [];
    return [{ ...block, text: collapsed.text }];
  });
  if (!found) return { message, found: false };
  if (content.length === 0) return { found: true };
  return { message: { ...message, content } as AgentMessage, found: true };
}

/** The newest task-message marker for this task already in the conversation. */
export function newestTaskMarker(
  messages: readonly AgentMessage[],
  taskId: string,
): Marker | undefined {
  const markers = markersFromMessages(messages).filter(
    (marker) => marker.batch.taskId === taskId && marker.batch.revision > 0,
  );
  if (markers.length === 0) return undefined;
  return markers.reduce((best, marker) =>
    marker.batch.revision > best.batch.revision ? marker : best,
  );
}

function taskMessagesEntry(content: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content,
    synthetic: true,
    attribution: "agent",
    timestamp,
  } as AgentMessage;
}

/**
 * The conversation with the placement applied: every marker for its task collapsed into one copy
 * of its batch, placed where the first marker was, or appended when there is none to replace.
 */
export function contextWithTaskMessages(
  messages: readonly AgentMessage[],
  placement: TaskMessagesPlacement,
  timestamp: number,
): AgentMessage[] {
  const { taskId, batch } = placement;
  const replacement = formatTaskMessages(taskId, batch.revision, batch.messages);
  if (!placement.replaceExisting) return [...messages, taskMessagesEntry(replacement, timestamp)];
  const insertion: MarkerInsertion = { inserted: false };
  const updated: AgentMessage[] = [];
  for (const message of messages) {
    const collapsed = collapseMessageMarkers(message, taskId, replacement, insertion);
    if (collapsed.message !== undefined) updated.push(collapsed.message);
  }
  if (!insertion.inserted) updated.push(taskMessagesEntry(replacement, timestamp));
  return updated;
}
