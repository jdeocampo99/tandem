import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_RESEARCH_HANDOFF_COUNT,
  MAX_RESEARCH_HANDOFF_EXCERPT_BYTES,
  MAX_RESEARCH_HANDOFF_TOTAL_BYTES,
  type ResearchHandoff,
} from "../contracts.ts";
import { taskJobsDirectory } from "../runtime/persistence.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import type { TaskStoreTransaction } from "../tasks/store.ts";
import { reportPathFor, singleLine } from "./records.ts";

export type ResearchHandoffSources = Readonly<{
  readonly home: string;
  /** The implementation task's project; every cited scout must belong to it. */
  readonly projectRepoPath: string;
  readonly runtime: RuntimeState;
  readonly store: Pick<TaskStoreTransaction, "read">;
}>;

type ResearchReport = Readonly<{
  readonly hasContent: boolean;
  readonly digest: string;
  readonly excerpt: string;
}>;

function pathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !relativePath.startsWith(sep)
  );
}

function boundedUtf8Prefix(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let end = Math.min(value.length, limit);
  while (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (
      Buffer.byteLength(value.slice(0, end), "utf8") <= limit &&
      (lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff)
    ) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

async function readBoundedResearchReport(path: string): Promise<ResearchReport> {
  const digest = createHash("sha256");
  let excerpt = "";
  let hasContent = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) continue;
    hasContent = true;
    digest.update(text);
    if (Buffer.byteLength(excerpt, "utf8") < MAX_RESEARCH_HANDOFF_EXCERPT_BYTES) {
      excerpt = boundedUtf8Prefix(`${excerpt}${text}`, MAX_RESEARCH_HANDOFF_EXCERPT_BYTES);
    }
  }
  return { hasContent, digest: digest.digest("hex"), excerpt };
}

/** The scout's report file, resolved physically and refused unless it is its own `report.txt`. */
async function physicalReportPath(
  scoutTaskId: string,
  reportPath: string,
  home: string,
): Promise<string> {
  const reportRoot = await realpath(taskJobsDirectory(home, scoutTaskId)).catch(() => undefined);
  const physicalReport = await realpath(resolve(reportPath)).catch(() => undefined);
  if (
    !isAbsolute(reportPath) ||
    reportRoot === undefined ||
    physicalReport === undefined ||
    basename(physicalReport) !== "report.txt" ||
    !pathWithin(reportRoot, physicalReport)
  ) {
    throw new Error(`research task ${scoutTaskId} has an unsafe or missing report`);
  }
  const metadata = await lstat(physicalReport);
  if (!metadata.isFile()) throw new Error(`research task ${scoutTaskId} report is not a file`);
  return physicalReport;
}

async function resolveResearchHandoff(
  scoutTaskId: string,
  projectRoot: string,
  sources: ResearchHandoffSources,
): Promise<ResearchHandoff> {
  const scout = await sources.store.read(scoutTaskId);
  if (scout === undefined || scout.kind !== "scout" || scout.stage !== "completed") {
    throw new Error(`research task ${scoutTaskId} is not a completed scout`);
  }
  if (scout.reportPath === undefined) {
    throw new Error(`research task ${scoutTaskId} has no completed report`);
  }
  if ((await realpath(scout.repoPath)) !== projectRoot) {
    throw new Error(`research task ${scoutTaskId} belongs to a different project`);
  }
  const runtimeTask = sources.runtime.tasks.find((entry) => entry.taskId === scout.id);
  if (
    runtimeTask === undefined ||
    runtimeTask.sourceCheckpoint.head.length === 0 ||
    runtimeTask.sourceCheckpoint.base.length === 0 ||
    runtimeTask.sourceCheckpoint.dirty ||
    runtimeTask.sourceCheckpoint.unmerged
  ) {
    throw new Error(`research task ${scoutTaskId} has invalid or stale source provenance`);
  }
  const reportPath = resolve(scout.reportPath);
  const physicalReport = await physicalReportPath(scout.id, scout.reportPath, sources.home);
  const scoutJob = runtimeTask.jobs.find(
    (job) =>
      job.role === "scout" &&
      job.phase === "consumed" &&
      job.generation === scout.generation &&
      resolve(reportPathFor(job.jobPath)) === reportPath,
  );
  if (scoutJob === undefined) {
    throw new Error(`research task ${scoutTaskId} report provenance is stale`);
  }
  const report = await readBoundedResearchReport(physicalReport);
  if (!report.hasContent) throw new Error(`research task ${scoutTaskId} report is empty`);
  return {
    scoutTaskId,
    scoutRepoPath: projectRoot,
    scoutSourceHead: runtimeTask.sourceCheckpoint.head,
    scoutSourceBase: runtimeTask.sourceCheckpoint.base,
    reportPath: physicalReport,
    reportDigest: report.digest,
    excerpt: report.excerpt,
  };
}

/**
 * The completed research an implementation task cites, each report checked for provenance and
 * excerpted within the handoff byte budget.
 */
export async function resolveResearchHandoffs(
  scoutTaskIds: readonly string[],
  sources: ResearchHandoffSources,
): Promise<readonly ResearchHandoff[]> {
  if (scoutTaskIds.length > MAX_RESEARCH_HANDOFF_COUNT) {
    throw new Error(`at most ${MAX_RESEARCH_HANDOFF_COUNT} research task references are allowed`);
  }
  const projectRoot = await realpath(sources.projectRepoPath);
  const handoffs: ResearchHandoff[] = [];
  for (const rawId of scoutTaskIds) {
    const scoutTaskId = singleLine(rawId, "researchTaskIds entry");
    if (handoffs.some((entry) => entry.scoutTaskId === scoutTaskId)) {
      throw new Error(`duplicate research task reference ${scoutTaskId}`);
    }
    handoffs.push(await resolveResearchHandoff(scoutTaskId, projectRoot, sources));
  }
  const totalBytes = handoffs.reduce(
    (total, handoff) => total + Buffer.byteLength(handoff.excerpt, "utf8"),
    0,
  );
  if (totalBytes > MAX_RESEARCH_HANDOFF_TOTAL_BYTES) {
    throw new Error(`research handoff exceeds ${MAX_RESEARCH_HANDOFF_TOTAL_BYTES} UTF-8 bytes`);
  }
  return handoffs;
}
