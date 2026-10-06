import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repositoryKey } from "../config/repositories.ts";
import { isNotFoundError } from "../config/storage.ts";
import { ensurePrivateDirectoryTree } from "../coordinator/lock.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import { shouldAutoShowCatchUp } from "./native-view.ts";

const visit = z.object({
  version: z.literal(1),
  project: z.string(),
  lastOpenedAt: z.string().datetime(),
  previousSignature: z.string().min(1),
  dismissedSignature: z.string().optional(),
});
export type NativeVisit = z.infer<typeof visit>;
export type NativeVisitInput = Readonly<{
  home: string;
  project: string;
  now: string;
  signature: string;
}>;

async function readVisit(path: string, project: string): Promise<NativeVisit | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      throw new Error("Native visit must be a bounded regular file");
    const saved = visit.parse(JSON.parse(await readFile(path, "utf8")));
    if (saved.project !== project) throw new Error("Native visit belongs to another project");
    return saved;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/** Host navigation state lives in Tandem's home. No task state or Tern settings are changed. */
async function updateVisit(
  input: NativeVisitInput,
  effect: (previous: NativeVisit | undefined) => Promise<NativeVisit>,
): Promise<void> {
  const directory = join(input.home, "native-visits");
  await ensurePrivateDirectoryTree(directory, "native visit directory");
  const path = join(directory, `${repositoryKey(input.project)}.json`);
  const release = await acquireDarwinFileLock(`${path}.lock`, 5000, 20);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const saved = await effect(await readVisit(path, input.project));
    await writeFile(temporary, JSON.stringify(visit.parse(saved)), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await release();
  }
}

/** Invoke only on a project visit, never on a view poll. Failed/uncertain opens stay unacknowledged. */
export async function visitNativeProject(
  input: NativeVisitInput,
  show: () => Promise<void>,
): Promise<boolean> {
  let shown = false;
  await updateVisit(input, async (previous) => {
    const shouldShow = shouldAutoShowCatchUp({
      now: input.now,
      currentSignature: input.signature,
      ...(previous === undefined
        ? {}
        : { lastOpenedAt: previous.lastOpenedAt, previousSignature: previous.previousSignature }),
    });
    if (shouldShow) {
      await show();
      shown = true;
    }
    return {
      version: 1,
      project: input.project,
      lastOpenedAt: input.now,
      previousSignature: input.signature,
    };
  });
  return shown;
}

export async function dismissNativeCatchUp(input: NativeVisitInput): Promise<void> {
  await updateVisit(input, async () => ({
    version: 1,
    project: input.project,
    lastOpenedAt: input.now,
    previousSignature: input.signature,
    dismissedSignature: input.signature,
  }));
}
