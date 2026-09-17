import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { hasDisallowedControlCharacter, isRecord } from "./values.ts";

export type PolicyTextReader = (
  absolutePath: string,
) => Promise<string | undefined> | string | undefined;

export type PolicyTextWriter = (absolutePath: string, text: string) => Promise<void> | void;

export type ResolvedHome = Readonly<{
  requested: string;
  canonical: string;
}>;

export type InspectedPolicyPath = Readonly<{
  exists: boolean;
}>;

function readPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty path`);
  }
  if (hasDisallowedControlCharacter(value, false)) {
    throw new TypeError(`${field} contains a control character or line break`);
  }
  return path.resolve(value);
}

export async function repositoryRoot(repoPath: string): Promise<string> {
  const requested = readPath(repoPath, "repoPath");
  const root = await realpath(requested);
  const details = await stat(root);
  if (!details.isDirectory()) {
    throw new TypeError("repoPath must resolve to a directory");
  }
  return root;
}

export async function configuredHome(home: string): Promise<ResolvedHome> {
  const requested = readPath(home, "home");
  const missing: string[] = [];
  let candidate = requested;

  while (true) {
    try {
      const physical = await realpath(candidate);
      const details = await stat(physical);
      if (!details.isDirectory()) {
        throw new TypeError("home must resolve to a directory");
      }
      return {
        requested,
        canonical: path.resolve(physical, ...missing),
      };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function assertContainedReference(root: string, reference: string): string {
  const candidate = path.resolve(root, ...reference.split("/"));
  if (!isContainedPath(root, candidate)) {
    throw new Error(`instruction reference escapes repository: ${reference}`);
  }
  return candidate;
}

export function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

export async function assertPhysicalRepositoryReference(
  root: string,
  candidate: string,
  reference: string,
): Promise<void> {
  let candidateRealPath: string;
  try {
    candidateRealPath = await realpath(candidate);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (!isContainedPath(root, candidateRealPath)) {
    throw new Error(`instruction reference resolves outside repository: ${reference}`);
  }
}

export async function inspectPolicyPath(
  paths: Readonly<{ home: string; config: string }>,
): Promise<InspectedPolicyPath> {
  if (!isContainedPath(paths.home, paths.config)) {
    throw new Error("central policy path escapes Tandem home");
  }

  const components = path.relative(paths.home, paths.config).split(path.sep);
  let current = paths.home;
  for (const [index, component] of components.entries()) {
    const candidate = path.join(current, component);
    let details: Stats;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (isNotFoundError(error)) return { exists: false };
      throw error;
    }

    if (details.isSymbolicLink()) {
      throw new Error(`central policy path contains a symlink: ${candidate}`);
    }
    if (index < components.length - 1 && !details.isDirectory()) {
      throw new Error(`central policy directory is not a directory: ${candidate}`);
    }
    if (index === components.length - 1) {
      return { exists: true };
    }
    current = candidate;
  }

  return { exists: false };
}

export async function ensurePrivateDirectoryTree(directory: string, field: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`${field} must be a private directory`);
      }
      break;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }

  for (const component of missing) {
    const next = path.join(current, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const details = await lstat(next);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`${field} must be a private directory`);
    }
    current = next;
  }
}

export async function ensureCentralDirectory(directory: string, field: string): Promise<void> {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink()) {
      throw new Error(`central policy path contains a symlink: ${directory}`);
    }
    if (!details.isDirectory()) throw new Error(`${field} must be a directory`);
    return;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${field} must be a private directory`);
  }
}
