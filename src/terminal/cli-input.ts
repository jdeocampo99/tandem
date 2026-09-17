import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TandemBoundaryEnvironment } from "../config/environment.ts";
import { parseModelAssignments } from "../config/models.ts";
import type { ModelSpec, RepoPolicy } from "../contracts.ts";
import type { PrSummary } from "../delivery/evidence.ts";
import type { CreateTaskRequest } from "../service/controller.ts";
import {
  type CliInvocation,
  type CliOptions,
  CliUsageError,
  parseJsonObject,
  parseTaskKind,
  pathText,
  requiredPositionOrOption,
  stringArray,
  text,
} from "./cli-arguments.ts";
import type { PathStat } from "./cli-process.ts";

export function repoFor(
  invocation: CliInvocation,
  environment: TandemBoundaryEnvironment,
  position = 0,
): string {
  if (invocation.options.repo !== undefined && invocation.positionals[position] !== undefined) {
    throw new CliUsageError(`repoPath was provided both as an option and a positional argument`);
  }
  return pathText(
    invocation.options.repo ?? invocation.positionals[position] ?? environment.repo,
    "repoPath",
  );
}

export function taskIdFor(invocation: CliInvocation): string {
  return requiredPositionOrOption(invocation, invocation.options.taskId, 0, "taskId");
}

export async function modelAssignmentsFromFile(
  statPath: (path: string) => Promise<PathStat>,
  file: string,
): Promise<RepoPolicy["models"]> {
  const inputPath = resolve(pathText(file, "input"));
  await verifyRegularPath(statPath, inputPath, "input");
  let source: string;
  try {
    source = await readFile(inputPath, "utf8");
  } catch (error) {
    throw new CliUsageError(
      `input is unavailable at ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseJsonObject(source, "input");
  try {
    return parseModelAssignments(parsed);
  } catch (error) {
    throw new CliUsageError(
      `input must contain a complete model assignment map: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function summaryFromValue(value: string, field = "summary"): PrSummary {
  const object = parseJsonObject(value, field);
  const keys = Object.keys(object);
  for (const key of keys) {
    if (key !== "tldr" && key !== "what" && key !== "why")
      throw new CliUsageError(`${field} contains unknown key ${JSON.stringify(key)}`);
  }
  return {
    tldr: stringArray(object.tldr, `${field}.tldr`),
    what: stringArray(object.what, `${field}.what`),
    why: stringArray(object.why, `${field}.why`),
  };
}

export function createInputFromInvocation(
  invocation: CliInvocation,
  environment: TandemBoundaryEnvironment,
): CreateTaskRequest {
  if (invocation.options.input !== undefined) {
    if (
      invocation.positionals.length > 0 ||
      invocation.options.repo !== undefined ||
      invocation.options.objective !== undefined ||
      invocation.options.kind !== undefined ||
      invocation.options.acceptanceCriteria.length > 0 ||
      invocation.options.surfaces.length > 0
    ) {
      throw new CliUsageError(
        "--input cannot be combined with create field flags or positional arguments",
      );
    }
    const object = parseJsonObject(invocation.options.input, "input");
    const allowed = ["repoPath", "kind", "objective", "acceptanceCriteria", "surfaces"] as const;
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key as (typeof allowed)[number]))
        throw new CliUsageError(`input contains unknown key ${JSON.stringify(key)}`);
    }
    return {
      repoPath: pathText(object.repoPath, "input.repoPath"),
      kind: parseTaskKind(text(object.kind, "input.kind")),
      objective: text(object.objective, "input.objective"),
      acceptanceCriteria: stringArray(object.acceptanceCriteria, "input.acceptanceCriteria"),
      surfaces: stringArray(object.surfaces, "input.surfaces"),
    };
  }
  const repoPath = repoFor(invocation, environment);
  const objective = requiredPositionOrOption(
    invocation,
    invocation.options.objective,
    1,
    "objective",
  );
  return {
    repoPath,
    kind: invocation.options.kind ?? "implementation",
    objective,
    acceptanceCriteria: invocation.options.acceptanceCriteria,
    surfaces: invocation.options.surfaces,
  };
}

export function summaryForInvocation(invocation: CliInvocation, position: number): PrSummary {
  const value = requiredPositionOrOption(
    invocation,
    invocation.options.summary,
    position,
    "summary",
  );
  return summaryFromValue(value);
}

export function modelForPolicy(policyModel: ModelSpec, options: CliOptions): ModelSpec {
  if (options.model !== undefined && options.model !== policyModel.model)
    throw new CliUsageError(
      `coordinator model is pinned to ${JSON.stringify(policyModel.model)} by Tandem policy`,
    );
  if (options.thinking !== undefined && options.thinking !== policyModel.thinking)
    throw new CliUsageError(
      `coordinator thinking is pinned to ${JSON.stringify(policyModel.thinking)} by Tandem policy`,
    );
  return policyModel;
}

export async function verifyRegularPath(
  statPath: (path: string) => Promise<PathStat>,
  path: string,
  field: string,
): Promise<void> {
  let stat: PathStat;
  try {
    stat = await statPath(path);
  } catch (error) {
    throw new Error(
      `${field} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${field} must be a regular non-symlink file: ${path}`);
}

export function checkLaunchText(value: string, field: string): string {
  const checked = text(value, field);
  if (checked.startsWith("-")) throw new CliUsageError(`${field} must not begin with '-'`);
  return checked;
}

export function checkLaunchPath(value: string, field: string): string {
  const checked = pathText(value, field);
  if (checked.startsWith("-")) throw new CliUsageError(`${field} must not begin with '-'`);
  return checked;
}
