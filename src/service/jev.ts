import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OmpModelRecord } from "../adapters/omp.ts";
import { listOmpModels } from "../adapters/omp.ts";
import {
  evaluateJev,
  JevEvaluationError,
  type JevEvaluationResponse,
  type JevFetch,
  type JevQuestion,
} from "../adapters/typesafe.ts";
import {
  type JevEnvironment,
  readJevEnvironment,
  readJevRoutingCandidates,
} from "../config/jev.ts";
import type { AgentRole, CommandRunner, TaskRecord, ThinkingLevel } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type { DurableJob } from "../runtime/schema.ts";
import { collectJevContextCandidates, type JevContextCandidate } from "./jev-context.ts";

const MAX_CONTEXT_EXCERPT = 1_200;
const MAX_CONTEXT_CANDIDATES = 8;
const MAX_REASON = 240;
const BASELINE_ID = "current-baseline";
export type JevShadowInput = Readonly<{
  readonly task: TaskRecord;
  readonly job: Pick<DurableJob, "id" | "role" | "jobPath" | "cwd">;
}>;

export type JevShadowStatus = "recorded" | "skipped" | "unavailable";
export type JevShadowResult = Readonly<{
  readonly status: JevShadowStatus;
  readonly artifactPath?: string;
  readonly message: string;
}>;

type JevEvaluatorDependencies = Readonly<{
  readonly home: string;
  readonly run: CommandRunner;
  readonly listTasks?: () => Promise<readonly TaskRecord[]>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: JevFetch;
  readonly clock?: () => string;
}>;

type RecommendationArtifact = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly jobId: string;
  readonly role: DurableJob["role"];
  readonly status: JevShadowStatus;
  readonly createdAt: string;
  readonly elapsedMs: number;
  readonly reason?: string;
  readonly providerModel?: string;
  readonly routing?: Readonly<{
    readonly baseline: Readonly<{ readonly model: string; readonly thinking: string }>;
    readonly choice?: Readonly<{
      readonly id: string;
      readonly model: string;
      readonly thinking: string;
      readonly confidence: number;
    }>;
  }>;
  readonly context?: readonly Readonly<{
    readonly id: string;
    readonly source: string;
    readonly relevance: number;
  }>[];
  readonly usage?: Readonly<{ readonly input_tokens: number; readonly output_tokens: number }>;
}>;

function bounded(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}
function safeStateText(value: string, prefixes: readonly string[], limit: number): string {
  let sanitized = value;
  for (const prefix of prefixes) {
    if (prefix.length > 0) sanitized = sanitized.split(prefix).join("[local-path]");
  }
  sanitized = sanitized.replace(
    /(?:\/Users|\/private|\/tmp|\/var|\/home)\/[^\s"'`]+/gu,
    "[local-path]",
  );
  sanitized = sanitized.replace(
    /\b(?:Bearer\s+|(?:sk|ghp|xox[baprs]-))[A-Za-z0-9._~+/=-]{12,}/giu,
    "[redacted]",
  );
  return bounded(sanitized, limit);
}
function containsCredentialLikeText(value: string): boolean {
  return (
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value) ||
    /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*[^\s"'`]{8,}/iu.test(value)
  );
}

function safeError(error: unknown): string {
  if (error instanceof JevEvaluationError) return `provider evaluation ${error.code}`;
  if (error instanceof TypeError) return "invalid Jev shadow configuration";
  return "Jev shadow provider unavailable";
}

function artifactPathFor(jobPath: string, jobId: string): string {
  const safeJobId = bounded(jobId.replace(/[^A-Za-z0-9_.:-]/gu, "_"), 96);
  return join(dirname(jobPath), `jev-recommendation-${safeJobId}.json`);
}

async function existingArtifact(
  path: string,
  expected: Pick<DurableJob, "id" | "role"> & Readonly<{ taskId: string }>,
): Promise<JevShadowResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RecommendationArtifact;
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.taskId !== expected.taskId ||
      parsed.jobId !== expected.id ||
      parsed.role !== expected.role ||
      (parsed.status !== "recorded" &&
        parsed.status !== "skipped" &&
        parsed.status !== "unavailable")
    )
      return undefined;
    return {
      status: parsed.status as JevShadowStatus,
      artifactPath: path,
      message:
        parsed.status === "recorded"
          ? `Jev shadow recommendation already recorded at ${path}`
          : `Jev shadow evaluation ${parsed.status}: ${parsed.reason ?? "see evidence"}`,
    };
  } catch {
    return undefined;
  }
}

function modelMatchesCatalogue(
  model: string,
  thinking: string,
  catalogue: readonly OmpModelRecord[],
): boolean {
  return catalogue.some(
    (entry) => entry.selector === model && entry.thinking.includes(thinking as ThinkingLevel),
  );
}
function modelState(
  task: TaskRecord,
  role: Exclude<AgentRole, "coordinator">,
  context: readonly JevContextCandidate[],
  redactions: readonly string[],
): Record<string, unknown> {
  return {
    task: {
      id: task.id,
      kind: task.kind,
      objective: safeStateText(task.objective, redactions, 1_800),
      acceptanceCriteria: task.acceptanceCriteria
        .slice(0, 12)
        .map((entry) => safeStateText(entry, redactions, 320)),
      surfaces: task.surfaces.slice(0, 24).map((entry) => safeStateText(entry, redactions, 180)),
      stage: task.stage,
      role,
    },
    supplementalContext: context.map((entry) => ({
      id: entry.id,
      excerpt: safeStateText(entry.excerpt, redactions, MAX_CONTEXT_EXCERPT),
    })),
  };
}

function questionSet(
  role: Exclude<AgentRole, "coordinator">,
  task: TaskRecord,
  candidates: readonly { id: string; model: string; thinking: string; description: string }[],
  context: readonly JevContextCandidate[],
): {
  questions: Readonly<Record<string, JevQuestion>>;
  approved: ReadonlyMap<string, (typeof candidates)[number]>;
} {
  const questions: Record<string, JevQuestion> = {};
  const approved = new Map<string, (typeof candidates)[number]>();
  const current = task.policy.config.models[role];
  const alternatives = candidates.filter((candidate) => {
    if (candidate.model === current.model && candidate.thinking === current.thinking) return false;
    if (approved.has(candidate.id)) return false;
    approved.set(candidate.id, candidate);
    return true;
  });
  if (alternatives.length > 0) {
    const criteria: Record<string, string> = {
      [BASELINE_ID]: `Keep the pinned current model ${current.model} at ${current.thinking} thinking.`,
    };
    for (const candidate of alternatives)
      criteria[candidate.id] = bounded(candidate.description, 360);
    questions.routing = {
      type: "choice",
      instructions: `For ${role} on this task, choose the best model configuration as a recommendation only. Do not authorize or change dispatch.`,
      criteria,
    };
  }
  for (const entry of context) {
    questions[`context:${entry.id}`] = {
      type: "noul",
      instructions: `Evaluate supplementalContext entry ${entry.id} from the state for the current ${role} work. Answer yes only when this exact supplemental evidence would improve understanding without replacing mandatory instructions or task scope.`,
      criteria: { true: "Relevant supplemental evidence", false: "Not relevant or unsafe to use" },
    };
  }
  return { questions, approved };
}

function contextScores(
  response: JevEvaluationResponse,
  context: readonly JevContextCandidate[],
): readonly { id: string; source: string; relevance: number }[] {
  return context
    .map((entry) => {
      const answer = response.answers[`context:${entry.id}`];
      const score = answer?.type === "noul" ? answer.noul : 0;
      return { id: entry.id, source: bounded(entry.source, 320), relevance: score };
    })
    .sort((left, right) => right.relevance - left.relevance)
    .map((entry) => ({ ...entry, relevance: Number(entry.relevance.toFixed(4)) }));
}

function routingResult(
  response: JevEvaluationResponse,
  task: TaskRecord,
  role: Exclude<AgentRole, "coordinator">,
  approved: ReadonlyMap<
    string,
    { id: string; model: string; thinking: string; description: string }
  >,
): NonNullable<RecommendationArtifact["routing"]> {
  const baseline = task.policy.config.models[role];
  const answer = response.answers.routing;
  if (answer?.type !== "choice") {
    return { baseline: { model: baseline.model, thinking: baseline.thinking } };
  }
  const choice = answer.choice === BASELINE_ID ? undefined : approved.get(answer.choice);
  return {
    baseline: { model: baseline.model, thinking: baseline.thinking },
    ...(choice === undefined
      ? {}
      : {
          choice: {
            id: choice.id,
            model: choice.model,
            thinking: choice.thinking,
            confidence: Number(answer.confidence.toFixed(4)),
          },
        }),
  };
}

export function createJevShadowEvaluator(deps: JevEvaluatorDependencies) {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? (() => new Date().toISOString());
  return async function evaluateShadow(input: JevShadowInput): Promise<JevShadowResult> {
    const started = Date.now();
    const requestedMode = env.TANDEM_JEV_MODE?.trim() ?? "off";
    if (requestedMode === "off") {
      return { status: "skipped", message: "Jev shadow mode is off" };
    }
    let environment: JevEnvironment;
    try {
      environment = readJevEnvironment(env);
    } catch (error) {
      return { status: "unavailable", message: safeError(error) };
    }
    if (environment.mode !== "shadow") {
      return { status: "skipped", message: "Jev shadow mode is off" };
    }
    const artifactPath = artifactPathFor(input.job.jobPath, input.job.id);
    const prior = await existingArtifact(artifactPath, {
      id: input.job.id,
      role: input.job.role,
      taskId: input.task.id,
    });
    if (prior !== undefined) return prior;
    const writeStatus = async (
      status: JevShadowStatus,
      reason: string,
    ): Promise<JevShadowResult> => {
      const artifact: RecommendationArtifact = {
        schemaVersion: 1,
        taskId: input.task.id,
        jobId: input.job.id,
        role: input.job.role,
        status,
        createdAt: clock(),
        elapsedMs: Math.max(0, Date.now() - started),
        reason: bounded(reason, MAX_REASON),
      };
      await writeJsonAtomically(artifactPath, artifact);
      return {
        status,
        artifactPath,
        message: `Jev shadow evaluation ${status}: ${artifact.reason}`,
      };
    };
    const writeUnavailable = (reason: string): Promise<JevShadowResult> =>
      writeStatus("unavailable", reason);
    const writeSkipped = (reason: string): Promise<JevShadowResult> =>
      writeStatus("skipped", reason);
    if (environment.key === undefined) return writeUnavailable("TYPESAFE_API_KEY is missing");
    try {
      const role = input.job.role === "validation" ? "verifier" : input.job.role;
      const candidatesByRole = await readJevRoutingCandidates(deps.home);
      let catalogue: readonly OmpModelRecord[] = [];
      try {
        catalogue = await listOmpModels(deps.run, { cwd: input.job.cwd });
      } catch {
        // Routing remains baseline-only when OMP catalogue inspection is unavailable.
      }
      const configured = candidatesByRole[role] ?? [];
      const candidates = configured.filter(
        (candidate) =>
          candidate.id !== BASELINE_ID &&
          modelMatchesCatalogue(candidate.model, candidate.thinking, catalogue),
      );
      const context = (
        await collectJevContextCandidates({
          task: input.task,
          tasks: (await deps.listTasks?.()) ?? [],
          home: deps.home,
          worktreePath: input.task.worktree?.path ?? input.task.repoPath,
        })
      )
        .filter((entry) => !containsCredentialLikeText(entry.excerpt))
        .slice(0, MAX_CONTEXT_CANDIDATES);
      const { questions, approved } = questionSet(role, input.task, candidates, context);
      if (Object.keys(questions).length === 0)
        return writeSkipped("no configured alternatives or eligible supplemental context");
      const state = modelState(input.task, role, context, [
        deps.home,
        input.job.cwd,
        input.task.repoPath,
      ]);
      const response = await evaluateJev(
        { model: environment.model, state, questions },
        {
          apiKey: environment.key,
          timeoutMs: environment.timeoutMs,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        },
      );
      const artifact: RecommendationArtifact = {
        schemaVersion: 1,
        taskId: input.task.id,
        jobId: input.job.id,
        role: input.job.role,
        status: "recorded",
        createdAt: clock(),
        elapsedMs: Math.max(0, Date.now() - started),
        providerModel: response.model,
        routing: routingResult(response, input.task, role, approved),
        context: contextScores(response, context),
        usage: response.usage,
      };
      await writeJsonAtomically(artifactPath, artifact);
      return {
        status: "recorded",
        artifactPath,
        message: `Jev shadow recommendation recorded at ${artifactPath}`,
      };
    } catch (error) {
      return writeUnavailable(safeError(error));
    }
  };
}

export function jevRecommendationNotification(result: JevShadowResult): string {
  return `[jev-shadow] ${bounded(result.message, 420)}`;
}
