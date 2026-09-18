import { isAbsolute } from "node:path";
import type { ReviewResult } from "../contracts.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import {
  parseReviewResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerRole,
  type WorkerStatus,
} from "./jobs.ts";

type JsonObject = Readonly<Record<string, unknown>>;

export type ParsedOmpOutput = Readonly<{
  readonly text: string;
}>;

export type ExpectedModel = Readonly<{
  readonly selector: string;
  readonly provider: string;
  readonly id: string;
}>;

export class WorkerOutputError extends Error {
  readonly outputText: string;

  constructor(message: string, outputText = "") {
    super(message);
    this.name = "WorkerOutputError";
    this.outputText = outputText;
  }
}

type ModelObservation = Readonly<{
  readonly provider?: string;
  readonly model?: string;
}>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectedModelParts(selector: string): ExpectedModel {
  const separator = selector.indexOf("/");
  return {
    selector,
    provider: selector.slice(0, separator),
    id: selector.slice(separator + 1),
  };
}

function modelObservation(value: unknown): ModelObservation | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  let provider: string | undefined =
    typeof value.provider === "string" ? value.provider : undefined;
  let model: string | undefined;
  if (typeof value.model === "string") {
    model = value.model;
  } else if (isJsonObject(value.model)) {
    if (provider === undefined && typeof value.model.provider === "string") {
      provider = value.model.provider;
    }
    if (typeof value.model.id === "string") {
      model = value.model.id;
    } else if (typeof value.model.name === "string") {
      model = value.model.name;
    } else if (typeof value.model.model === "string") {
      model = value.model.model;
    }
  }
  if (provider === undefined && model === undefined) {
    return undefined;
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function modelMismatchReason(event: JsonObject, expected: ExpectedModel): string | undefined {
  const values: unknown[] = [event, event.message, event.metadata];
  if (Array.isArray(event.messages)) {
    values.push(...event.messages);
  }
  for (const value of values) {
    const observation = modelObservation(value);
    if (observation === undefined) {
      continue;
    }
    if (observation.provider !== undefined && observation.provider !== expected.provider) {
      return `OMP selected provider ${observation.provider}, expected ${expected.provider}`;
    }
    if (
      observation.model !== undefined &&
      observation.model !== expected.id &&
      observation.model !== expected.selector
    ) {
      return `OMP selected model ${observation.model}, expected ${expected.selector}`;
    }
  }
  return undefined;
}

function readEventFailure(event: JsonObject): string | undefined {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (type.includes("error") || type.includes("abort") || type.includes("cancel")) {
    return describeFailure(
      event.error ?? event.message,
      `OMP emitted ${type || "a failure event"}`,
    );
  }

  const status = typeof event.status === "string" ? event.status.toLowerCase() : "";
  if (status === "error" || status === "failed" || status === "aborted" || status === "cancelled") {
    return describeFailure(event.error ?? event.message, `OMP reported status ${status}`);
  }
  if (event.isError === true || event.aborted === true || event.cancelled === true) {
    return describeFailure(event.error ?? event.message, "OMP reported an unsuccessful turn");
  }
  if (event.error !== undefined && event.error !== null && event.error !== "") {
    return describeFailure(event.error, "OMP reported a provider error");
  }
  if (
    isJsonObject(event.message) &&
    event.message.error !== undefined &&
    event.message.error !== null &&
    event.message.error !== ""
  ) {
    return describeFailure(event.message.error, "OMP reported a provider error");
  }

  const stopReason = stopReasonFrom(event);
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") {
    return `OMP stopped with ${stopReason}`;
  }
  return undefined;
}

function describeFailure(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isJsonObject(value) && typeof value.message === "string" && value.message.trim().length > 0) {
    return value.message.trim();
  }
  return fallback;
}

function stopReasonFrom(event: JsonObject): string | undefined {
  if (typeof event.stopReason === "string") {
    return event.stopReason.toLowerCase();
  }
  if (isJsonObject(event.message) && typeof event.message.stopReason === "string") {
    return event.message.stopReason.toLowerCase();
  }
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (isJsonObject(message) && typeof message.stopReason === "string") {
        return message.stopReason.toLowerCase();
      }
    }
  }
  return undefined;
}

function assistantMessageText(message: unknown): string | undefined {
  if (!isJsonObject(message) || message.role !== "assistant") {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (!isJsonObject(block)) {
      continue;
    }
    if (block.type === "text" || block.type === "output_text") {
      if (typeof block.text !== "string") {
        throw new WorkerOutputError("OMP assistant text block is malformed");
      }
      textBlocks.push(block.text);
    }
  }
  return textBlocks.length === 0 ? undefined : textBlocks.join("");
}

function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const finalMessage = messages[messages.length - 1];
  return assistantMessageText(finalMessage);
}

export type NativeAgentEnd = Readonly<{
  readonly type: "agent_end";
  readonly messages: readonly unknown[];
  readonly willContinue?: boolean;
}>;

function nativeAgentEnd(value: unknown): NativeAgentEnd {
  if (!isJsonObject(value) || value.type !== "agent_end" || !Array.isArray(value.messages)) {
    throw new WorkerOutputError("OMP emitted a malformed agent_end event");
  }
  return {
    type: "agent_end",
    messages: value.messages,
    ...(value.willContinue === undefined ? {} : { willContinue: value.willContinue === true }),
  };
}

/**
 * Parse the native extension event rather than the OMP process's terminal output.
 *
 * The interactive process owns stdout/stderr, so treating either stream as a
 * transport would corrupt the user's TUI and impose an arbitrary capture cap.
 */
export function parseNativeAgentEnd(
  value: unknown,
  expectedModel: ExpectedModel,
  selectedModel: unknown,
): ParsedOmpOutput {
  const event = nativeAgentEnd(value);
  const eventMismatch = modelMismatchReason(event, expectedModel);
  if (eventMismatch !== undefined) throw new WorkerOutputError(eventMismatch);
  const mismatch = modelMismatchReason({ model: selectedModel }, expectedModel);
  if (mismatch !== undefined) throw new WorkerOutputError(mismatch);
  if (!isJsonObject(selectedModel)) {
    throw new WorkerOutputError("OMP did not expose the selected model");
  }
  const selected = modelObservation({ model: selectedModel });
  if (selected === undefined || selected.provider === undefined || selected.model === undefined) {
    throw new WorkerOutputError("OMP did not expose complete selected model metadata");
  }
  const terminalCandidate = finalAssistantText(event.messages);
  if (terminalCandidate === undefined || terminalCandidate.trim().length === 0) {
    throw new WorkerOutputError("OMP terminal agent_end has no final assistant text");
  }
  return { text: terminalCandidate };
}

export function nativeAgentEndWillContinue(value: unknown): boolean {
  return nativeAgentEnd(value).willContinue === true;
}

export function readNativeEventFailure(value: unknown): string | undefined {
  return isJsonObject(value) ? readEventFailure(value) : "OMP emitted a malformed lifecycle event";
}

export function parseReviewWorkerText(job: WorkerJob, text: string): ReviewResult {
  if (job.review === undefined) {
    throw new WorkerOutputError("review worker job is missing review identity", text);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkerOutputError(
      `review worker output is not strict JSON: ${error instanceof Error ? error.message : "parse failure"}`,
      text,
    );
  }
  let review: ReviewResult;
  try {
    review = parseReviewResult(value);
  } catch (error) {
    throw new WorkerOutputError(
      `review worker output does not match ReviewResult: ${error instanceof Error ? error.message : "invalid review"}`,
      text,
    );
  }
  if (
    review.head !== job.review.head ||
    review.lens !== job.review.lens ||
    review.generation !== job.generation
  ) {
    throw new WorkerOutputError(
      "review worker output identity does not match the worker job",
      text,
    );
  }
  return review;
}

export type ReportedOutcome = Readonly<{
  readonly status: WorkerStatus;
  readonly error?: string;
}>;

export function reportedOutcome(role: WorkerRole, text: string): ReportedOutcome {
  if (role !== "implementer") {
    return { status: "completed" };
  }
  const matches = [
    ...text.matchAll(/^\s*Outcome\s*:\s*(implemented|needs-decision|failed)\s*$/gim),
  ];
  if (matches.length !== 1) {
    return {
      status: "failed",
      error:
        "implementer output must include exactly one Outcome: implemented|needs-decision|failed line",
    };
  }
  const outcome = matches[0]?.[1]?.toLowerCase();
  if (outcome === "needs-decision") {
    return { status: "needs-decision" };
  }
  if (outcome === "failed") {
    return { status: "failed", error: "implementer reported a failed outcome" };
  }
  return { status: "completed" };
}

export type ReportedQuestion = Readonly<{
  readonly question?: WorkerQuestion;
  readonly error?: string;
}>;

export function reportedQuestion(
  role: WorkerRole,
  status: WorkerStatus,
  text: string,
): ReportedQuestion {
  if (role !== "implementer" || status !== "needs-decision") return {};
  const questionMatches = [...text.matchAll(/^\s*Question\s*:\s*([^\r\n]+?)\s*$/gim)];
  if (questionMatches.length !== 1) {
    return {
      error: "needs-decision implementer output must include exactly one Question: <text> line",
    };
  }
  const questionText = questionMatches[0]?.[1]?.trim();
  if (questionText === undefined || questionText.length === 0) {
    return { error: "needs-decision Question: line must contain text" };
  }
  if (questionText.length > MAX_TASK_MESSAGE_CHARS) {
    return {
      error: `needs-decision question exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`,
    };
  }

  const recommendationMatches = [...text.matchAll(/^\s*Recommendation\s*:\s*([^\r\n]+?)\s*$/gim)];
  if (recommendationMatches.length > 1) {
    return {
      error: "needs-decision implementer output may include at most one Recommendation: line",
    };
  }
  const recommendation = recommendationMatches[0]?.[1]?.trim();
  if (recommendation !== undefined && recommendation.length > MAX_TASK_MESSAGE_CHARS) {
    return {
      error: `needs-decision recommendation exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`,
    };
  }
  return {
    question: {
      text: questionText,
      ...(recommendation === undefined || recommendation.length === 0 ? {} : { recommendation }),
    },
  };
}

export type ReportedArtifact = Readonly<{
  readonly artifactPath?: string;
  readonly error?: string;
}>;

export function artifactPathFromText(role: WorkerRole, text: string): ReportedArtifact {
  if (role !== "presentation") {
    return {};
  }
  const matches = [...text.matchAll(/^\s*Artifact\s*:\s*(\/[^\r\n]+?)\s*$/gim)];
  const capturedPath = matches[0]?.[1];
  if (matches.length !== 1 || capturedPath === undefined) {
    return {
      error: "presentation output must include exactly one Artifact: <absolute path> line",
    };
  }
  const candidate = capturedPath.replace(/[.,;:)\]}]+$/u, "");
  if (!isAbsolute(candidate)) {
    return { error: "presentation Artifact path must be absolute" };
  }
  return { artifactPath: candidate };
}
