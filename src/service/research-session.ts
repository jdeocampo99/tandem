import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_RESEARCH_DECISION_TEXT_BYTES } from "../contracts.ts";
import { taskJobsDirectory } from "../runtime/persistence.ts";

const MAX_RESEARCH_RESULT_FILE_BYTES = MAX_RESEARCH_DECISION_TEXT_BYTES * 6 + 512;

export type ResearchFollowUpFiles = Readonly<{
  readonly briefPath: string;
  readonly resultPath: string;
}>;

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function writeOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== Buffer.byteLength(content, "utf8") ||
      (await readFile(path, "utf8")) !== content
    ) {
      throw new Error("research follow-up brief path is occupied by different or unsafe content");
    }
  }
}

export async function createResearchFollowUpFiles(
  input: Readonly<{
    readonly home: string;
    readonly taskId: string;
    readonly jobPath: string;
    readonly decisionId: string;
    readonly brief: string;
  }>,
): Promise<ResearchFollowUpFiles> {
  if (!isAbsolute(input.jobPath) || input.jobPath.includes("\0")) {
    throw new TypeError("research job path must be absolute without NUL characters");
  }
  const [root, jobDirectory] = await Promise.all([
    realpath(taskJobsDirectory(input.home, input.taskId)),
    realpath(dirname(input.jobPath)),
  ]);
  if (!pathWithin(root, jobDirectory)) {
    throw new Error("research job path is outside its task's durable job directory");
  }
  const token = createHash("sha256").update(input.decisionId).digest("hex");
  const briefPath = join(jobDirectory, `research-follow-up-${token}.brief.txt`);
  const resultPath = join(jobDirectory, `research-follow-up-${token}.result.json`);
  await writeOnce(briefPath, input.brief);
  return { briefPath, resultPath };
}

export async function readResearchFollowUpAnswer(
  resultPath: string,
  decisionId: string,
): Promise<string | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(resultPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("research follow-up result is not a regular file");
  }
  if (metadata.size > MAX_RESEARCH_RESULT_FILE_BYTES) {
    throw new Error("research follow-up result exceeds the durable result size limit");
  }
  const value: unknown = JSON.parse(await readFile(resolve(resultPath), "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.keys(value).every((key) => ["schemaVersion", "decisionId", "answer"].includes(key)) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("decisionId" in value) ||
    value.decisionId !== decisionId ||
    !("answer" in value) ||
    typeof value.answer !== "string" ||
    value.answer.trim().length === 0 ||
    value.answer.includes("\0") ||
    Buffer.byteLength(value.answer, "utf8") > MAX_RESEARCH_DECISION_TEXT_BYTES
  ) {
    throw new Error("research follow-up result is malformed or belongs to another decision");
  }
  return value.answer;
}
