import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isContainedPath } from "../config/storage.ts";
import { writeNewTextAtomically, writeTextAtomically } from "../runtime/persistence.ts";
import {
  homeSpecialistFolder,
  RESERVED_SPECIALIST_NAME,
  specialistFileRevision,
} from "./registry.ts";
import {
  SPECIALIST_NAME_PATTERN,
  type SpecialistFields,
  specialistMarkdown,
} from "./specialist.ts";

/** One Just-me file to create, replace or delete; `revision` is the hash of the bytes the user saw. */
export type SpecialistChange =
  | Readonly<{ op: "create"; name: string; fields: SpecialistFields }>
  | Readonly<{ op: "update"; name: string; revision: string; fields: SpecialistFields }>
  | Readonly<{ op: "remove"; name: string; revision: string }>;

/**
 * Writes or removes `<tandemHome>/specialists/<name>.md`, the only place Tandem writes a specialist.
 * It builds the path from the name, so it can never write inside a repository. Refuses a name the
 * loader would not read or the reserved one; a `specialists` folder that is a symbolic link or
 * whose real path leaves the Tandem home; a create over any existing entry (`link()` from a
 * temporary file, so a case-insensitive clash such as Foo.md is refused too); and an update or
 * remove whose file is a link or whose bytes no longer hash to `revision`. Text comes only from
 * specialistMarkdown; writes are atomic.
 */
export async function changeHomeSpecialist(
  tandemHome: string,
  change: SpecialistChange,
): Promise<Readonly<{ path: string }>> {
  const { name } = change;
  if (!SPECIALIST_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${name}" is not a specialist name; use lowercase letters, digits, and hyphens (at most 40)`,
    );
  }
  if (name === RESERVED_SPECIALIST_NAME) {
    throw new Error(`${name} is Tandem's own fix-round checklist; pick another name`);
  }
  let text: string | undefined;
  if (change.op !== "remove") {
    const written = specialistMarkdown(name, change.fields);
    if (!written.ok) throw new Error(`${name}: ${written.problem}`);
    text = written.text;
  }
  const folder = await writableFolder(tandemHome);
  const path = join(folder, `${name}.md`);
  if (change.op === "create") {
    try {
      await writeNewTextAtomically(path, text ?? "");
    } catch (error) {
      if (codeOf(error) === "EEXIST") {
        throw new Error(`Just me already has ${name} (${path}). Pick another name.`);
      }
      throw error;
    }
    return { path };
  }
  await requireRevision(path, name, change.revision);
  if (change.op === "update") await writeTextAtomically(path, text ?? "");
  else await unlink(path);
  return { path };
}

/** The home's `specialists` folder, created when missing; never a link to somewhere else. */
async function writableFolder(tandemHome: string): Promise<string> {
  const folder = homeSpecialistFolder(tandemHome);
  try {
    const info = await lstat(folder);
    if (info.isSymbolicLink()) {
      throw new Error(
        `${folder} is a link to another folder, so Tandem only reads it. Change those files where the link points, or replace the link with a real folder.`,
      );
    }
    if (!info.isDirectory()) throw new Error(`${folder} is not a folder`);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }
  if (!isContainedPath(await realpath(tandemHome), await realpath(folder))) {
    throw new Error(`${folder} points outside the Tandem home, so Tandem won't write there`);
  }
  return folder;
}

async function requireRevision(path: string, name: string, revision: string): Promise<void> {
  const stale = `${name} changed on disk since Settings showed it. Reopen Settings.`;
  let bytes: Buffer;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${path} is not a regular file, so Tandem won't change it`);
    }
    bytes = await readFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") throw new Error(stale);
    throw error;
  }
  if (specialistFileRevision(bytes) !== revision) throw new Error(stale);
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
