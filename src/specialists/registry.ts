import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isContainedPath } from "../config/storage.ts";
import { BUILT_IN_SPECIALISTS, FALLBACK_SPECIALIST } from "./built-in.ts";
import { MAX_GUESS_CANDIDATES, type SpecialistCandidate } from "./classify.ts";
import {
  MAX_SPECIALIST_BYTES,
  readSpecialistMarkdown,
  SPECIALIST_NAME_PATTERN,
  type Specialist,
  type SpecialistCheck,
  type SpecialistOrigin,
} from "./specialist.ts";

export type SpecialistSearch = Readonly<{
  /** Checkout of the repository the task works in, the same one skills are read from. */
  readonly repositoryCheckout: string;
  /** The Tandem home; its `specialists/` folder holds the user's private specialists. */
  readonly tandemHome: string;
}>;

/** A file or folder Tandem could not use; registry-wide problems have no path. */
export type SpecialistProblem = Readonly<{ readonly path?: string; readonly problem: string }>;

/** One per name: the winner by precedence (repository, home, built-in), or the broken file that won. */
export type SpecialistEntry =
  | Readonly<{
      readonly status: "ready";
      readonly specialist: Specialist;
      /** Lower-precedence origins with the same name that this one hides. */
      readonly replaces: readonly SpecialistOrigin[];
    }>
  | Readonly<{
      readonly status: "broken";
      readonly name: string;
      readonly origin: FileOrigin;
      readonly path: string;
      readonly problem: string;
      readonly replaces: readonly SpecialistOrigin[];
    }>;

export type SpecialistRegistry = Readonly<{
  readonly folders: Readonly<{ readonly repository: string; readonly home: string }>;
  /** Sorted by name. */
  readonly entries: readonly SpecialistEntry[];
  /** Every problem, including files hidden by a higher-precedence file and files with no valid name. */
  readonly problems: readonly SpecialistProblem[];
  /** Every file with a valid name in both folders, winners and hidden ones, repository first. */
  readonly files: readonly SpecialistFile[];
}>;

/** One file with a valid name in either folder, whether it wins its name or is hidden. */
export type SpecialistFile = Readonly<{
  readonly origin: FileOrigin;
  readonly name: string;
  readonly path: string;
  readonly result: SpecialistCheck;
  /** Of the bytes read; absent when the file was not read whole (too large, not a file, outside the folder). */
  readonly revision?: string;
}>;

type FileOrigin = "repository" | "home";
type FolderRead = Readonly<{
  readonly files: readonly SpecialistFile[];
  readonly problems: readonly SpecialistProblem[];
}>;

const REPOSITORY_FOLDER = join(".tandem", "specialists");
/** Tandem's own fix-round checklist; a file can't take its name. */
export const RESERVED_SPECIALIST_NAME = "fix-round";

/** `<tandemHome>/specialists`: the user's own specialists, which only home-files.ts writes. */
export function homeSpecialistFolder(tandemHome: string): string {
  return join(tandemHome, "specialists");
}

/** The only revision function: the registry computes it, the writer and sharing compare it. */
export function specialistFileRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads both folders and merges them over the built-ins. A missing folder is empty, not a problem. */
export async function loadSpecialists(search: SpecialistSearch): Promise<SpecialistRegistry> {
  const folders = {
    repository: join(search.repositoryCheckout, REPOSITORY_FOLDER),
    home: homeSpecialistFolder(search.tandemHome),
  };
  const [repository, home] = await Promise.all([
    readFolder(folders.repository, "repository", search.repositoryCheckout),
    readFolder(folders.home, "home"),
  ]);
  const merged = mergeByPrecedence(repository.files, home.files);
  const guessable = merged.entries.filter(
    (entry) => entry.status === "ready" && entry.specialist.description !== undefined,
  ).length;
  const capacity: readonly SpecialistProblem[] =
    guessable > MAX_GUESS_CANDIDATES
      ? [
          {
            problem: `${guessable} specialists have a description, but Tandem guesses among at most ${MAX_GUESS_CANDIDATES}, so it won't guess; remove the description from some`,
          },
        ]
      : [];
  return {
    folders,
    entries: merged.entries,
    problems: [...repository.problems, ...home.problems, ...merged.problems, ...capacity],
    files: [...repository.files, ...home.files],
  };
}

/** The ready specialists Tandem can guess between, or none when there are too many to ask about. */
export function guessCandidates(registry: SpecialistRegistry): readonly SpecialistCandidate[] {
  const candidates = registry.entries.flatMap((entry) =>
    entry.status === "ready" && entry.specialist.description !== undefined
      ? [{ name: entry.specialist.name, description: entry.specialist.description }]
      : [],
  );
  return candidates.length > MAX_GUESS_CANDIDATES ? [] : candidates;
}

/**
 * The specialist a new implementation task pins: the named one, or the guess among those with a
 * description, or general. A broken winning file fails closed rather than falling back silently.
 */
export async function pinSpecialist(
  registry: SpecialistRegistry,
  requested: string | undefined,
  guess: (candidates: readonly SpecialistCandidate[]) => Promise<string | undefined>,
): Promise<Specialist> {
  if (requested !== undefined) {
    const entry = registry.entries.find((candidate) => entryName(candidate) === requested);
    if (entry === undefined) {
      throw new TypeError(
        `No specialist named ${requested}. This project has: ${registry.entries.map(entryName).join(", ")}. Ask the user which one they meant.`,
      );
    }
    return usable(entry);
  }
  const candidates = guessCandidates(registry);
  const picked = candidates.length === 0 ? undefined : await guess(candidates);
  const name = candidates.some((candidate) => candidate.name === picked)
    ? picked
    : FALLBACK_SPECIALIST;
  const entry = registry.entries.find((candidate) => entryName(candidate) === name);
  if (entry === undefined) throw new Error(`the ${FALLBACK_SPECIALIST} specialist is missing`);
  return usable(entry);
}

export function entryName(entry: SpecialistEntry): string {
  return entry.status === "ready" ? entry.specialist.name : entry.name;
}

function usable(entry: SpecialistEntry): Specialist {
  if (entry.status === "ready") return entry.specialist;
  throw new TypeError(
    `The specialist ${entry.name} can't be used: ${entry.path} ${entry.problem}. Fix the file or remove it.`,
  );
}

/** Pure: per name, the first of repository > home > built-in decides; broken files block their name. */
function mergeByPrecedence(
  repository: readonly SpecialistFile[],
  home: readonly SpecialistFile[],
): Omit<SpecialistRegistry, "folders" | "files"> {
  const names = new Set([
    ...BUILT_IN_SPECIALISTS.map((specialist) => specialist.name),
    ...repository.map((file) => file.name),
    ...home.map((file) => file.name),
  ]);
  const entries: SpecialistEntry[] = [];
  for (const name of [...names].sort()) {
    const layers: readonly Readonly<{ origin: SpecialistOrigin; file?: SpecialistFile }>[] = [
      ...[...repository, ...home]
        .filter((file) => file.name === name)
        .map((file) => ({ origin: file.origin, file })),
      ...BUILT_IN_SPECIALISTS.filter((specialist) => specialist.name === name).map(() => ({
        origin: "built-in" as const,
      })),
    ];
    const [winner, ...hidden] = layers;
    if (winner === undefined) continue;
    const replaces = hidden.map((layer) => layer.origin);
    const builtIn = BUILT_IN_SPECIALISTS.find((specialist) => specialist.name === name);
    if (winner.file === undefined) {
      if (builtIn !== undefined) entries.push({ status: "ready", specialist: builtIn, replaces });
      continue;
    }
    const { file } = winner;
    const { origin } = file;
    entries.push(
      file.result.valid
        ? { status: "ready", specialist: file.result.specialist, replaces }
        : {
            status: "broken",
            name,
            origin,
            path: file.path,
            problem: file.result.defect,
            replaces,
          },
    );
  }
  const problems = [...repository, ...home].flatMap((file) =>
    file.result.valid ? [] : [{ path: file.path, problem: file.result.defect }],
  );
  return { entries, problems };
}

/** `checkout`, when given, must contain the folder's real path; a linked `.tandem` could otherwise pull in files from anywhere. */
async function readFolder(
  folder: string,
  origin: FileOrigin,
  checkout?: string,
): Promise<FolderRead> {
  let listing: Dirent[];
  try {
    listing = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { files: [], problems: [] };
    return {
      files: [],
      problems: [{ path: folder, problem: `can't read the folder: ${message(error)}` }],
    };
  }
  if (checkout !== undefined) {
    try {
      if (!isContainedPath(await realpath(checkout), await realpath(folder))) {
        return {
          files: [],
          problems: [{ path: folder, problem: "points outside the repository" }],
        };
      }
    } catch (error) {
      return {
        files: [],
        problems: [{ path: folder, problem: `can't read the folder: ${message(error)}` }],
      };
    }
  }
  const files: SpecialistFile[] = [];
  const problems: SpecialistProblem[] = [];
  for (const dirent of listing.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!dirent.name.endsWith(".md")) continue;
    const name = dirent.name.slice(0, -".md".length);
    const path = join(folder, dirent.name);
    if (!SPECIALIST_NAME_PATTERN.test(name)) {
      problems.push({
        path,
        problem: `"${name}" is not a specialist name; use lowercase letters, digits, and hyphens`,
      });
      continue;
    }
    if (name === RESERVED_SPECIALIST_NAME) {
      problems.push({
        path,
        problem: `${RESERVED_SPECIALIST_NAME} is Tandem's own fix-round checklist; rename the file`,
      });
      continue;
    }
    files.push({ origin, name, path, ...(await readSpecialistFile(folder, path, name, origin)) });
  }
  return { files, problems };
}

async function readSpecialistFile(
  folder: string,
  path: string,
  stem: string,
  origin: FileOrigin,
): Promise<Readonly<{ result: SpecialistCheck; revision?: string }>> {
  const broken = (defect: string) => ({ result: { valid: false as const, defect } });
  try {
    if (!isContainedPath(await realpath(folder), await realpath(path))) {
      return broken("points outside .tandem/specialists");
    }
    const info = await stat(path);
    if (!info.isFile()) return broken("is not a regular file");
    if (info.size > MAX_SPECIALIST_BYTES) {
      return broken(`is ${info.size} bytes; a specialist file is at most ${MAX_SPECIALIST_BYTES}`);
    }
    const bytes = await readFile(path);
    const revision = specialistFileRevision(bytes);
    const result = readSpecialistMarkdown(bytes.toString("utf8"), { origin, path });
    if (result.valid && result.specialist.name !== stem) {
      return {
        result: {
          valid: false,
          defect: `names itself "${result.specialist.name}"; the name must match the file name "${stem}"`,
        },
        revision,
      };
    }
    return { result, revision };
  } catch (error) {
    return broken(`can't be read: ${message(error)}`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
