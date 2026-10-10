import { TextDecoder } from "node:util";
import {
  JEV_PRICING_SNAPSHOT,
  USAGE_RECORD_SCHEMA_VERSION,
  type UsageRecord,
} from "../runtime/usage.ts";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0" as const;
export const JEV_PROVIDER = "typesafe" as const;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_QUESTIONS = 64;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_CRITERIA = 64;
const PROBABILITY_EPSILON = 1e-6;

type JevState = string | readonly unknown[] | Readonly<Record<string, unknown>>;

type JevChoiceQuestion = Readonly<{
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}>;

type JevNoulQuestion = Readonly<{
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: Readonly<{ readonly true?: string | null; readonly false?: string | null }>;
}>;

type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export type JevEvaluationInput = Readonly<{
  readonly model: string;
  readonly state: JevState;
  readonly questions: JevQuestions;
}>;

export type JevChoiceAnswer = Readonly<{
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}>;

type JevNoulAnswer = Readonly<{
  readonly type: "noul";
  readonly noul: number;
}>;

type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export type JevUsage = Readonly<{
  readonly input_tokens: number;
  readonly output_tokens: number;
}>;

export type JevEvaluationResponse = Readonly<{
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
}>;

export type JevFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A Portkey gateway in front of TypeSafe. It forwards the same request and response bodies, so
 * only the URL, the extra headers, and the gateway's name for Jev differ from a direct call.
 */
export type JevGateway = Readonly<{
  readonly url: string;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
}>;

export type JevEvaluationOptions = Readonly<{
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly gateway?: JevGateway;
  readonly fetch?: JevFetch;
}>;

const GATEWAY_HEADERS = [
  ["x-portkey-api-key", "PORTKEY_API_KEY"],
  ["x-portkey-provider", "PORTKEY_PROVIDER"],
  ["x-portkey-custom-host", "PORTKEY_CUSTOM_HOST"],
] as const;

/** Reads a Portkey gateway from an environment-shaped record; none unless `PORTKEY_BASE_URL` is set. */
export function jevGateway(
  source: Readonly<Record<string, string | undefined>>,
): JevGateway | undefined {
  const baseUrl = source.PORTKEY_BASE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const [header, name] of GATEWAY_HEADERS) {
    const value = source[name]?.trim();
    if (value !== undefined && value.length > 0) headers[header] = value;
  }
  const model = source.PORTKEY_JEV_MODEL?.trim();
  return {
    url: `${baseUrl.replace(/\/+$/u, "")}/proxy/decisions`,
    model: model === undefined || model.length === 0 ? JEV_MODEL : model,
    headers,
  };
}

export class JevEvaluationError extends Error {
  readonly code: "invalid-request" | "unavailable" | "invalid-response" | "timeout";

  constructor(
    code: "invalid-request" | "unavailable" | "invalid-response" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "JevEvaluationError";
    this.code = code;
  }
}

/** How one Jev call ended, which is what decides whether its token counts exist at all. */
export type JevAttemptOutcome =
  | Readonly<{ readonly kind: "answered"; readonly usage: JevUsage }>
  | Readonly<{ readonly kind: "failed"; readonly code: JevEvaluationError["code"] }>;

/**
 * The bounded usage record for one Jev call, so every caller of this boundary describes its
 * provider usage the same way. A call that never answered reports unavailable token counts
 * rather than zero, which would read as a call that used nothing.
 */
export function jevUsageRecord(
  attempt: Readonly<{
    readonly outcome: JevAttemptOutcome;
    readonly durationMs: number;
    readonly reason: string;
  }>,
): UsageRecord {
  const shared = {
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: JEV_PROVIDER,
    model: JEV_MODEL,
    durationMs: attempt.durationMs,
    reason: attempt.reason,
    pricing: JEV_PRICING_SNAPSHOT,
  } as const;
  if (attempt.outcome.kind === "answered") {
    return {
      ...shared,
      inputTokens: attempt.outcome.usage.input_tokens,
      outputTokens: attempt.outcome.usage.output_tokens,
      timedOut: false,
    };
  }
  return {
    ...shared,
    inputTokens: "unavailable",
    outputTokens: "unavailable",
    timedOut: attempt.outcome.code === "timeout",
  };
}

function fail(code: JevEvaluationError["code"], message: string): never {
  throw new JevEvaluationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isQuestionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    fail("invalid-request", `${field} is invalid`);
  }
  if (value.includes("\0")) fail("invalid-request", `${field} is invalid`);
  return value;
}

function validateState(state: unknown): asserts state is JevState {
  if (typeof state !== "string" && !Array.isArray(state) && !(isRecord(state) && state !== null)) {
    fail("invalid-request", "state is invalid");
  }
}

function validateQuestion(question: unknown, id: string): asserts question is JevQuestion {
  if (!isRecord(question) || typeof question.type !== "string") {
    fail("invalid-request", `question ${id} is invalid`);
  }
  if (question.type === "choice") {
    const keys = Object.keys(question);
    if (!keys.every((key) => key === "type" || key === "instructions" || key === "criteria")) {
      fail("invalid-request", `question ${id} is invalid`);
    }
    readText(question.instructions, `question ${id} instructions`);
    if (!isRecord(question.criteria)) fail("invalid-request", `question ${id} criteria is invalid`);
    const criteria = question.criteria;
    const options = Object.keys(criteria);
    if (options.length < 2 || options.length > MAX_CRITERIA) {
      fail("invalid-request", `question ${id} criteria is invalid`);
    }
    for (const option of options) {
      if (!isQuestionId(option)) fail("invalid-request", `question ${id} criteria is invalid`);
      const description = criteria[option];
      if (description !== null) readText(description, `question ${id} criteria`);
    }
    return;
  }
  if (question.type === "noul") {
    const keys = Object.keys(question);
    if (!keys.every((key) => key === "type" || key === "instructions" || key === "criteria")) {
      fail("invalid-request", `question ${id} is invalid`);
    }
    readText(question.instructions, `question ${id} instructions`);
    if (question.criteria !== undefined) {
      if (!isRecord(question.criteria))
        fail("invalid-request", `question ${id} criteria is invalid`);
      for (const key of Object.keys(question.criteria)) {
        if (key !== "true" && key !== "false")
          fail("invalid-request", `question ${id} criteria is invalid`);
        const description = question.criteria[key];
        if (description !== null) readText(description, `question ${id} criteria`);
      }
    }
    return;
  }
  fail("invalid-request", `question ${id} type is invalid`);
}

function validateInput(input: JevEvaluationInput, wireModel: string): string {
  if (!isRecord(input) || input.model !== JEV_MODEL) {
    fail("invalid-request", "evaluation input is invalid");
  }
  validateState(input.state);
  if (!isRecord(input.questions)) fail("invalid-request", "questions are invalid");
  const ids = Object.keys(input.questions);
  if (ids.length === 0 || ids.length > MAX_QUESTIONS)
    fail("invalid-request", "questions are invalid");
  for (const id of ids) {
    if (!isQuestionId(id)) fail("invalid-request", "question id is invalid");
    validateQuestion(input.questions[id], id);
  }
  let body: string;
  try {
    body = JSON.stringify({ ...input, model: wireModel });
  } catch {
    fail("invalid-request", "evaluation input is invalid");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    fail("invalid-request", "evaluation input is too large");
  }
  return body;
}

function validateUsage(value: unknown): JevUsage {
  if (!isRecord(value)) fail("invalid-response", "Jev response is invalid");
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    fail("invalid-response", "Jev response is invalid");
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

function validateAnswer(value: unknown, question: JevQuestion, id: string): JevAnswer {
  if (!isRecord(value) || value.type !== question.type)
    fail("invalid-response", `answer ${id} is invalid`);
  if (question.type === "noul") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "noul")) {
      fail("invalid-response", `answer ${id} is invalid`);
    }
    if (!isFiniteUnit(value.noul)) fail("invalid-response", `answer ${id} is invalid`);
    return { type: "noul", noul: value.noul };
  }
  if (
    Object.keys(value).some(
      (key) =>
        key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence",
    )
  ) {
    fail("invalid-response", `answer ${id} is invalid`);
  }
  if (typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice)) {
    fail("invalid-response", `answer ${id} is invalid`);
  }
  if (!isRecord(value.probabilities)) fail("invalid-response", `answer ${id} is invalid`);
  const optionIds = Object.keys(question.criteria);
  const probabilityIds = Object.keys(value.probabilities);
  if (
    probabilityIds.length !== optionIds.length ||
    probabilityIds.some((option) => !Object.hasOwn(question.criteria, option))
  ) {
    fail("invalid-response", `answer ${id} is invalid`);
  }
  let total = 0;
  const probabilities: Record<string, number> = {};
  for (const option of optionIds) {
    const probability = value.probabilities[option];
    if (!isFiniteUnit(probability)) fail("invalid-response", `answer ${id} is invalid`);
    total += probability;
    probabilities[option] = probability;
  }
  if (Math.abs(total - 1) > PROBABILITY_EPSILON || !isFiniteUnit(value.confidence)) {
    fail("invalid-response", `answer ${id} is invalid`);
  }
  return { type: "choice", choice: value.choice, probabilities, confidence: value.confidence };
}

function validateResponse(
  value: unknown,
  questions: JevQuestions,
  wireModel: string,
): JevEvaluationResponse {
  if (!isRecord(value) || value.model !== wireModel || !isRecord(value.answers)) {
    fail("invalid-response", "Jev response is invalid");
  }
  const ids = Object.keys(questions);
  const answerIds = Object.keys(value.answers);
  if (answerIds.length !== ids.length || answerIds.some((id) => !Object.hasOwn(questions, id))) {
    fail("invalid-response", "Jev response is invalid");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const id of ids) {
    const question = questions[id];
    const answer = value.answers[id];
    if (question === undefined || answer === undefined)
      fail("invalid-response", "Jev response is invalid");
    answers[id] = validateAnswer(answer, question, id);
  }
  return { model: JEV_MODEL, answers, usage: validateUsage(value.usage) };
}
async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      fail("invalid-response", "Jev response is invalid");
    }
  }
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  if (response.body === null) {
    const text = await Promise.race([response.text(), abort]);
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      fail("invalid-response", "Jev response is invalid");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("invalid-response", "Jev response is invalid");
      chunks.push(chunk);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function evaluateJev(
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
): Promise<JevEvaluationResponse> {
  // The gateway may name the same Jev model differently; results still report JEV_MODEL.
  const wireModel = options.gateway?.model ?? JEV_MODEL;
  const requestBody = validateInput(input, wireModel);
  if (
    !isRecord(options) ||
    typeof options.apiKey !== "string" ||
    options.apiKey.trim().length === 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 10_000
  ) {
    fail("invalid-request", "Jev evaluation options are invalid");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JevEvaluationError("timeout", "Jev request timed out"));
    }, options.timeoutMs);
  });
  const fetchImpl = options.fetch ?? fetch;
  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(options.gateway?.url ?? TYPESAFE_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            ...options.gateway?.headers,
          },
          body: requestBody,
        }),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof JevEvaluationError) throw error;
      if (controller.signal.aborted) fail("timeout", "Jev request timed out");
      fail("unavailable", "Jev service unavailable");
    }
    if (!response.ok) fail("unavailable", "Jev service unavailable");
    let responseBody: string;
    try {
      responseBody = await readBoundedBody(response, controller.signal);
    } catch (error) {
      if (error instanceof JevEvaluationError) throw error;
      if (controller.signal.aborted) fail("timeout", "Jev request timed out");
      fail("unavailable", "Jev service unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody) as unknown;
    } catch {
      fail("invalid-response", "Jev response is invalid");
    }
    return validateResponse(parsed, input.questions, wireModel);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The routed confidence for one choice answer: the lesser of the model's stated confidence
 * and the probability it assigned to its own chosen option. Shared by every Jev router so
 * they agree on what "confident" means, and so evaluation tooling can reproduce the figure.
 */
export function choiceConfidence(answer: JevChoiceAnswer): number | undefined {
  const probability = answer.probabilities[answer.choice];
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    !Number.isFinite(answer.confidence)
  ) {
    return undefined;
  }
  return Math.min(answer.confidence, probability);
}
