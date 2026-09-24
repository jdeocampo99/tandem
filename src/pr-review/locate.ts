import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clock, CommandRunner } from "../contracts.ts";
import {
  deleteRepoLocation,
  readRepoLocation,
  withStateTransaction,
  writeRepoLocation,
} from "../runtime/database.ts";

/**
 * Where a GitHub repository lives on this machine. `ambiguous` and `missing` are questions for the
 * user; their answer goes back through `rememberRepoLocation`.
 */
export type RepoLocation =
  | Readonly<{ kind: "found"; path: string; remote: string }>
  | Readonly<{ kind: "ambiguous"; paths: readonly string[] }>
  | Readonly<{ kind: "missing" }>;

export type LocateRepoOptions = Readonly<{
  home: string;
  /** Folders crawled for checkouts, such as `~/Coding/Projects`. */
  roots: readonly string[];
  run: CommandRunner;
  clock: Clock;
}>;

export type RememberRepoOptions = Omit<LocateRepoOptions, "roots">;

/** Folders below a root that are searched; checkouts are rarely nested deeper than org/repo. */
const MAX_CRAWL_DEPTH = 3;

const GITHUB_REMOTE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** Saved location first, then a crawl of the roots; a single crawl hit is saved for next time. */
export async function locateRepo(repo: string, options: LocateRepoOptions): Promise<RepoLocation> {
  const name = repoName(repo);
  const saved = await withStateTransaction(options.home, (db) => readRepoLocation(db, name));
  if (saved !== undefined) {
    const remote = await matchingRemote(saved, name, options.run);
    if (remote !== undefined) {
      await save(name, saved, options);
      return { kind: "found", path: saved, remote };
    }
    await withStateTransaction(options.home, (db) => deleteRepoLocation(db, name));
  }

  const matches: { path: string; remote: string }[] = [];
  for (const checkout of await crawlCheckouts(options.roots)) {
    const remote = await matchingRemote(checkout, name, options.run);
    if (remote !== undefined) matches.push({ path: checkout, remote });
  }
  const [only, ...others] = matches;
  if (only === undefined) return { kind: "missing" };
  if (others.length > 0) return { kind: "ambiguous", paths: matches.map((match) => match.path) };
  await save(name, only.path, options);
  return { kind: "found", ...only };
}

/** Checks a path the user named and saves it; `missing` means it is not a checkout of `repo`. */
export async function rememberRepoLocation(
  repo: string,
  path: string,
  options: RememberRepoOptions,
): Promise<RepoLocation> {
  const name = repoName(repo);
  const checkout = resolve(path);
  const remote = await matchingRemote(checkout, name, options.run);
  if (remote === undefined) return { kind: "missing" };
  await save(name, checkout, options);
  return { kind: "found", path: checkout, remote };
}

/** `owner/repo` from a GitHub remote URL in any of its https, ssh, or scp-like spellings. */
export function githubRepoFromRemote(url: string): string | undefined {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function repoName(repo: string): string {
  const parts = repo.trim().split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || /\s/.test(part))) {
    throw new TypeError(`repository must be owner/repo, got ${JSON.stringify(repo)}`);
  }
  return parts.join("/").toLowerCase();
}

async function save(
  repo: string,
  path: string,
  options: Pick<LocateRepoOptions, "home" | "clock">,
): Promise<void> {
  await withStateTransaction(options.home, (db) =>
    writeRepoLocation(db, { repo, path, lastUsedAt: options.clock() }),
  );
}

/**
 * The remote pointing at `repo`, preferring `origin` so fork setups with an `upstream` still work.
 * A folder that is gone or is not a git checkout simply does not match.
 */
async function matchingRemote(
  path: string,
  repo: string,
  run: CommandRunner,
): Promise<string | undefined> {
  if (!(await isDirectory(path))) return undefined;
  const result = await run({ argv: ["git", "-C", path, "remote", "-v"], cwd: path });
  if (result.code !== 0) return undefined;
  const remotes = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [remote, url] = line.split(/\s+/);
    if (remote !== undefined && url !== undefined && githubRepoFromRemote(url) === repo) {
      remotes.add(remote);
    }
  }
  return remotes.has("origin") ? "origin" : [...remotes].sort()[0];
}

/** Folders holding a `.git` entry; hidden folders, `node_modules`, and symlinks are not followed. */
async function crawlCheckouts(roots: readonly string[]): Promise<readonly string[]> {
  const checkouts: string[] = [];
  let level = roots.map((root) => resolve(root));
  for (let depth = 0; depth <= MAX_CRAWL_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const folder of level) {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.name === ".git")) {
        checkouts.push(folder);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          next.push(join(folder, entry.name));
        }
      }
    }
    level = next;
  }
  return checkouts.sort();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
