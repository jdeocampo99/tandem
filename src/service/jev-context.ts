import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import type { TaskRecord } from "../contracts.ts";

export type JevContextCandidate = Readonly<{
  readonly id: string;
  readonly source: string;
  readonly excerpt: string;
}>;

export type JevContextInput = Readonly<{
  readonly task: TaskRecord;
  readonly tasks: readonly TaskRecord[];
  readonly home: string;
  readonly worktreePath: string;
}>;

/** Conservative limits keep shadow ranking supplemental and prevent accidental history dumps. */
export const JEV_CONTEXT_LIMITS = {
  maxCandidates: 12,
  maxExcerptBytes: 4_000,
  maxTotalBytes: 24_000,
  maxSurfacePathChars: 512,
} as const;

const TEXT_EXTENSIONS: Readonly<Record<string, true>> = {
  ".c": true,
  ".cc": true,
  ".cpp": true,
  ".cxx": true,
  ".css": true,
  ".go": true,
  ".h": true,
  ".hpp": true,
  ".html": true,
  ".java": true,
  ".js": true,
  ".json": true,
  ".jsonc": true,
  ".jsx": true,
  ".kt": true,
  ".md": true,
  ".mjs": true,
  ".mts": true,
  ".py": true,
  ".rs": true,
  ".scss": true,
  ".sh": true,
  ".sql": true,
  ".swift": true,
  ".ts": true,
  ".tsx": true,
  ".txt": true,
  ".cts": true,
  ".yml": true,
  ".yaml": true,
};

const SECRET_FILE_NAME =
  /(?:^|[._-])(?:env|secret|secrets|credential|credentials|token|password|passwd|apikey|api-key|private|id_rsa)(?:$|[._-])/iu;
const SECRET_FILE_EXTENSION = /\.(?:key|pem|p12|pfx|der)$/iu;

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${"/"}`));
}

function stableId(kind: "scout" | "surface", value: string): string {
  const digest = createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 20);
  return `jev-${kind}-${digest}`;
}

function isSafeText(value: string): boolean {
  if (value.includes("\0") || value.includes("\ufffd")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code < 0x09 && code !== 0x0a) || (code > 0x0d && code < 0x20)) {
      return false;
    }
  }
  return true;
}

async function readBoundedText(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(JEV_CONTEXT_LIMITS.maxExcerptBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const excerpt = buffer.subarray(0, bytesRead).toString("utf8").trim();
    return isSafeText(excerpt) && excerpt.length > 0 ? excerpt : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function physicalPath(path: string): Promise<string | undefined> {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) return undefined;
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function looksLikeSurfacePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > JEV_CONTEXT_LIMITS.maxSurfacePathChars ||
    value.trim() !== value ||
    value.includes("\0") ||
    /\s/u.test(value) ||
    value.includes("://") ||
    value.includes(":") ||
    value.includes("*") ||
    value.includes("[") ||
    value.includes("]") ||
    value.includes("{") ||
    value.includes("}") ||
    value === "." ||
    value === ".." ||
    value.endsWith("/")
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  }
  const extension = extname(value).toLowerCase();
  return TEXT_EXTENSIONS[extension] === true;
}

function isSecretPath(root: string, path: string): boolean {
  const segments = relative(root, path).split(/[\\/]/u);
  return segments.some(
    (segment) =>
      segment.startsWith(".env") ||
      SECRET_FILE_NAME.test(segment) ||
      SECRET_FILE_EXTENSION.test(segment),
  );
}

export async function collectJevContextCandidates(
  input: JevContextInput,
): Promise<readonly JevContextCandidate[]> {
  if (
    input === undefined ||
    input === null ||
    typeof input !== "object" ||
    input.task === undefined ||
    input.task === null ||
    typeof input.task !== "object" ||
    !Array.isArray(input.task.surfaces) ||
    !Array.isArray(input.tasks) ||
    typeof input.home !== "string" ||
    typeof input.worktreePath !== "string"
  ) {
    return [];
  }

  const [homeRoot, worktreeRoot, projectRoot] = await Promise.all([
    physicalPath(input.home),
    physicalPath(input.worktreePath),
    physicalPath(input.task.repoPath),
  ]);
  if (homeRoot === undefined || worktreeRoot === undefined || projectRoot === undefined) return [];
  const candidates: JevContextCandidate[] = [];
  let totalBytes = 0;
  const append = (candidate: JevContextCandidate): boolean => {
    const size = Buffer.byteLength(candidate.excerpt, "utf8");
    if (
      size === 0 ||
      size > JEV_CONTEXT_LIMITS.maxExcerptBytes ||
      totalBytes + size > JEV_CONTEXT_LIMITS.maxTotalBytes ||
      candidates.length >= JEV_CONTEXT_LIMITS.maxCandidates
    ) {
      return false;
    }
    candidates.push(candidate);
    totalBytes += size;
    return true;
  };

  const scoutTasks: Array<{ readonly task: TaskRecord; readonly reportPath: string }> = [];
  for (const candidateTask of input.tasks) {
    if (
      candidateTask === undefined ||
      candidateTask === null ||
      typeof candidateTask !== "object"
    ) {
      continue;
    }
    if (
      candidateTask.id === input.task.id ||
      candidateTask.kind !== "scout" ||
      candidateTask.stage !== "completed" ||
      candidateTask.reportPath === undefined
    ) {
      continue;
    }
    const candidateProject = await physicalPath(candidateTask.repoPath);
    if (candidateProject !== projectRoot) continue;
    const reportPath = await physicalPath(candidateTask.reportPath);
    const reportRoot = resolve(homeRoot, "jobs", candidateTask.id);
    if (
      reportPath === undefined ||
      !isWithin(reportRoot, reportPath) ||
      basename(reportPath) !== "report.txt"
    ) {
      continue;
    }
    if (!isWithin(homeRoot, reportPath)) continue;
    scoutTasks.push({ task: candidateTask, reportPath });
  }

  scoutTasks.sort((left, right) => {
    const taskOrder = left.task.id.localeCompare(right.task.id);
    return taskOrder === 0 ? left.reportPath.localeCompare(right.reportPath) : taskOrder;
  });

  for (const { task: scoutTask, reportPath } of scoutTasks) {
    if (candidates.length >= JEV_CONTEXT_LIMITS.maxCandidates) break;
    const excerpt = await readBoundedText(reportPath);
    if (excerpt === undefined) continue;
    append({
      id: stableId("scout", `${scoutTask.id}\0${reportPath}`),
      source: `scout report ${scoutTask.id}`,
      excerpt,
    });
  }

  const seenSurfaces = new Set<string>();
  for (const surface of input.task.surfaces) {
    if (candidates.length >= JEV_CONTEXT_LIMITS.maxCandidates) break;
    if (typeof surface !== "string" || !looksLikeSurfacePath(surface)) continue;
    const candidatePath = resolve(worktreeRoot, surface);
    if (!isWithin(worktreeRoot, candidatePath) || isSecretPath(worktreeRoot, candidatePath))
      continue;
    const physicalCandidate = await physicalPath(candidatePath);
    if (
      physicalCandidate === undefined ||
      physicalCandidate === worktreeRoot ||
      !isWithin(worktreeRoot, physicalCandidate) ||
      isSecretPath(worktreeRoot, physicalCandidate) ||
      seenSurfaces.has(physicalCandidate)
    ) {
      continue;
    }
    seenSurfaces.add(physicalCandidate);
    const excerpt = await readBoundedText(physicalCandidate);
    if (excerpt === undefined) continue;
    append({
      id: stableId("surface", relative(worktreeRoot, physicalCandidate)),
      source: `surface ${relative(worktreeRoot, physicalCandidate) || "."}`,
      excerpt,
    });
  }

  return candidates;
}
