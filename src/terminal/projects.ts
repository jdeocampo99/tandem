import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CommandRunner } from "../contracts.ts";
import { listCoordinatorRecords } from "../coordinator/registry.ts";
import type { TerminalInvocation } from "./arguments.ts";
import type { TerminalEnvironment } from "./environment.ts";
import { askProjectSelection, type TerminalPrompt, type TerminalPrompter } from "./onboarding.ts";
import { streamIsTTY } from "./process.ts";

async function canonicalExistingPath(candidate: string): Promise<string> {
  const physical = await realpath(candidate);
  const details = await stat(physical);
  if (!details.isDirectory()) throw new Error(`project path must be a directory: ${candidate}`);
  return physical;
}

/** Resolves a path through Git so symlink aliases and subdirectories use one real project root. */
export async function gitRootForPath(
  candidate: string,
  cwd: string,
  run: CommandRunner,
): Promise<string | undefined> {
  const requested = resolve(cwd, candidate);
  const physical = await canonicalExistingPath(requested);
  const result = await run({
    argv: ["git", "-C", physical, "rev-parse", "--show-toplevel"],
    cwd: physical,
  });
  if (result.code !== 0) return undefined;
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error(`git returned no repository root for ${requested}`);
  const root = await canonicalExistingPath(resolve(physical, output));
  return root;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRegisteredProjects(home: string): Promise<readonly string[]> {
  const directory = join(home, "repositories");
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const configPath = join(directory, entry.name, "config.json");
    let details: Stats;
    try {
      details = await lstat(configPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`registered project record is not a regular file: ${configPath}`);
    }
    const text = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `registered project record ${configPath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.repoPath !== "string") {
      throw new Error(
        `registered project record ${configPath} has no valid schemaVersion or repoPath`,
      );
    }
    const repoPath = parsed.repoPath.trim();
    if (repoPath.length === 0 || !isAbsolute(repoPath)) {
      throw new Error(`registered project record ${configPath} contains a non-absolute repoPath`);
    }
    try {
      const canonical = await canonicalExistingPath(repoPath);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        projects.push(canonical);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return projects.sort((left, right) => left.localeCompare(right));
}

async function canonicalIfAvailable(candidate: string): Promise<string | undefined> {
  try {
    return await canonicalExistingPath(candidate);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function gitCommonDirectory(root: string, run: CommandRunner): Promise<string> {
  const result = await run({
    argv: ["git", "-C", root, "rev-parse", "--git-common-dir"],
    cwd: root,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `could not validate Git identity for ${root}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  const common = result.stdout.trim();
  if (common.length === 0) throw new Error(`Git returned no common directory for ${root}`);
  return realpath(resolve(root, common));
}

async function validateSharedGitIdentity(
  originalRoot: string,
  checkoutRoot: string,
  run: CommandRunner,
): Promise<void> {
  if (originalRoot === checkoutRoot) {
    throw new Error("coordinator identity claimed a clean checkout identical to the original root");
  }
  const [originalCommon, checkoutCommon] = await Promise.all([
    gitCommonDirectory(originalRoot, run),
    gitCommonDirectory(checkoutRoot, run),
  ]);
  if (originalCommon !== checkoutCommon) {
    throw new Error(
      `coordinator identity roots ${JSON.stringify(originalRoot)} and ${JSON.stringify(checkoutRoot)} do not share a Git common directory`,
    );
  }
}

async function mapCoordinatorCheckoutIdentity(
  root: string,
  environment: TerminalEnvironment,
  run: CommandRunner,
  allowRegistryLookup: boolean,
): Promise<string> {
  const sourceValue = environment.source.TANDEM_SOURCE_REPO;
  const originalValue = environment.source.TANDEM_REPO;
  if (sourceValue !== undefined && originalValue !== undefined) {
    const sourcePath = await canonicalIfAvailable(sourceValue);
    if (sourcePath === root) {
      const originalRoot = await gitRootForPath(originalValue, environment.cwd, run);
      if (originalRoot === undefined) {
        throw new Error(
          "TANDEM_REPO is not a Git repository for the active coordinator checkout; refusing to onboard the clean checkout",
        );
      }
      await validateSharedGitIdentity(originalRoot, root, run);
      return originalRoot;
    }
  }
  if (!allowRegistryLookup) return root;

  const records = await listCoordinatorRecords(environment.home, environment.sessionId);
  const matches: string[] = [];
  for (const record of records) {
    const worktreePath = await canonicalIfAvailable(record.worktree.path);
    if (worktreePath === root) matches.push(record.repoPath);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple coordinator records claim clean checkout ${JSON.stringify(root)}; refusing to guess the original project`,
    );
  }
  const recordedOriginal = matches[0];
  if (recordedOriginal === undefined) return root;
  const originalRoot = await gitRootForPath(recordedOriginal, environment.cwd, run);
  if (originalRoot === undefined) {
    throw new Error(
      `coordinator registry points to a non-Git original project ${JSON.stringify(recordedOriginal)}; refusing to onboard the clean checkout`,
    );
  }
  await validateSharedGitIdentity(originalRoot, root, run);
  return originalRoot;
}

export function interactiveFor(
  dependencies: Readonly<{ readonly prompt?: TerminalPrompt; readonly isTTY?: boolean }>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): boolean {
  if (dependencies.prompt !== undefined) return true;
  return dependencies.isTTY ?? (streamIsTTY(input) && streamIsTTY(output));
}
export function noTtyError(operation: string): Error {
  return new Error(
    `${operation} needs an interactive terminal for explicit choices; rerun from a TTY or provide a configured project path. No settings or coordinator was started.`,
  );
}

async function resolveProjectRoots(
  paths: readonly string[],
  environment: TerminalEnvironment,
  run: CommandRunner,
  currentRootForMapping?: string,
): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const root = await gitRootForPath(path, environment.cwd, run);
    if (root === undefined) {
      throw new Error(
        `${path} is not inside a Git repository; Tandem requires the actual Git root`,
      );
    }
    const projectRoot = await mapCoordinatorCheckoutIdentity(
      root,
      environment,
      run,
      root === currentRootForMapping,
    );
    if (!seen.has(projectRoot)) {
      seen.add(projectRoot);
      roots.push(projectRoot);
    }
  }
  return roots;
}

export async function selectProjects(
  invocation: TerminalInvocation,
  environment: TerminalEnvironment,
  run: CommandRunner,
  interactive: boolean,
  prompter: TerminalPrompter | undefined,
): Promise<readonly string[] | undefined> {
  if (invocation.paths.length > 0) {
    const current = await gitRootForPath(environment.cwd, environment.cwd, run);
    return resolveProjectRoots(invocation.paths, environment, run, current);
  }

  let registered: readonly string[] | undefined;
  if (
    invocation.command === "launch" ||
    invocation.command === "update" ||
    invocation.command === "reset"
  ) {
    registered = await readRegisteredProjects(environment.home);
    if (registered.length > 0) {
      return resolveProjectRoots(registered, environment, run);
    }
  }

  const current = await gitRootForPath(environment.cwd, environment.cwd, run);
  if (current !== undefined) {
    return [await mapCoordinatorCheckoutIdentity(current, environment, run, true)];
  }
  if (!interactive || prompter === undefined) throw noTtyError("project selection");
  registered ??= await readRegisteredProjects(environment.home);
  const selected = await askProjectSelection(prompter, registered);
  if (selected === undefined) return undefined;
  return resolveProjectRoots(selected, environment, run);
}
