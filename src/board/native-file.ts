import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { nativeViewsPath } from "./snapshot.ts";

/** Only the navigation fields are read here; each renderer validates its own domain model. */
const navigationModel = z.object({
  version: z.literal(1),
  project: z.string(),
  changeSignature: z.string().min(1).optional(),
  writtenAt: z.string(),
  tasks: z.record(z.object({ detailFile: z.string() })),
  briefs: z.record(z.object({ detailFile: z.string() })),
  pullRequests: z.record(
    z.object({
      detailFile: z.string(),
      header: z.object({
        taskId: z.string().optional(),
        repo: z.string(),
        number: z.number().int().positive(),
      }),
    }),
  ),
  projects: z.array(
    z.object({
      terminal: z.literal("tern"),
      repoPath: z.string(),
      current: z.boolean(),
      offline: z.boolean(),
      sessionId: z.string().optional(),
    }),
  ),
});
export type NativeNavigationModel = z.infer<typeof navigationModel>;
export async function readNativeBundle(
  home: string,
  project: string,
): Promise<NativeNavigationModel> {
  const path = nativeViewsPath(home, project);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Native view index must be a bounded regular file");
  const envelope = z
    .object({
      version: z.literal(1),
      kind: z.literal("panel"),
      revision: z.string(),
      model: navigationModel,
    })
    .parse(JSON.parse(await readFile(path, "utf8")));
  if (envelope.model.project !== project) throw new Error("Native view belongs to another project");
  return envelope.model;
}
