import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readGitText, runChecked } from "../adapters/primitives.ts";
import { readHomeSettings } from "../config/home-settings.ts";
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

/** How the user answered "where is it?": a path they named, "clone it", or neither yet. */
export type CheckoutAnswer = Readonly<{
  checkout?: string | undefined;
  clone?: boolean | undefined;
}>;

/** Clones on "clone it", checks a named path, and otherwise looks the repository up. */
export async function findCheckout(
  repo: string,
  answer: CheckoutAnswer,
  options: LocateRepoOptions,
): Promise<RepoLocation> {
  const remember = { home: options.home, run: options.run, clock: options.clock };
  if (answer.clone === true) {
    return rememberRepoLocation(repo, await cloneRepo(options.run, repo, options.home), remember);
  }
  if (answer.checkout !== undefined) return rememberRepoLocation(repo, answer.checkout, remember);
  return locateRepo(repo, options);
}

/** The question to ask when a repository was not found in exactly one place. */
export function checkoutQuestion(
  repo: string,
  location: Exclude<RepoLocation, { kind: "found" }>,
  named?: string,
): string {
  if (location.kind === "ambiguous") {
    return `I found ${repo} in more than one place: ${location.paths.join(", ")}. Which one should I use?`;
  }
  return named === undefined
    ? `Where's ${repo} on your machine? Or say "clone it".`
    : `${named} isn't a checkout of ${repo}. Where is it? Or say "clone it".`;
}

/** Where people usually keep code, under their home folder; searched until they name their own. */
const COMMON_CODE_FOLDERS: readonly string[] = [
  "Coding/Projects",
  "code",
  "Code",
  "Projects",
  "projects",
  "src",
  "dev",
  "Developer",
  "git",
  "repos",
  "workspace",
  "GitHub",
  "Documents/GitHub",
];

/**
 * The folders crawled for checkouts: `TANDEM_PROJECT_ROOTS` (colon-separated) when set, then the
 * code folders saved in the home settings, then the usual places under the home folder.
 */
export async function projectRoots(
  home: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<readonly string[]> {
  const configured = environment.TANDEM_PROJECT_ROOTS?.split(":").filter((root) => root.length > 0);
  if (configured !== undefined && configured.length > 0) return configured;
  const saved = (await readHomeSettings(home)).projectRoots;
  if (saved.length > 0) return saved;
  return COMMON_CODE_FOLDERS.map((folder) => join(homedir(), folder));
}

/** A checkout found by name, with the GitHub repository its `origin` names, when there is one. */
export type NamedCheckout = Readonly<{ path: string; repo?: string }>;

/** `~` or `~/...` under the home folder; any other path unchanged. */
export function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/u, homedir());
}

/**
 * Checkouts the user could mean by `name`: a path (starting with `/`, `~`, or `.`) is resolved to
 * its Git root; anything else matches a checkout's folder name, its GitHub repository name, or its
 * `owner/repo`, ignoring case. The caller asks the user when there is not exactly one.
 */
export async function findCheckoutsByName(
  name: string,
  roots: readonly string[],
  run: CommandRunner,
): Promise<readonly NamedCheckout[]> {
  const wanted = name.trim();
  if (/^[/~.]/u.test(wanted)) {
    const path = resolve(expandHome(wanted));
    if (!(await isDirectory(path))) return [];
    const root = await run({
      argv: ["git", "-C", path, "rev-parse", "--show-toplevel"],
      cwd: path,
    });
    if (root.code !== 0) return [];
    const checkout = await realpath(root.stdout.trim());
    return [await describeCheckout(checkout, run)];
  }
  const lowered = wanted.toLowerCase();
  const found: NamedCheckout[] = [];
  for (const checkout of await crawlCheckouts(roots)) {
    const described = await describeCheckout(checkout, run);
    const matches =
      basename(checkout).toLowerCase() === lowered ||
      described.repo === lowered ||
      described.repo?.split("/")[1] === lowered;
    if (matches) found.push(described);
  }
  return found;
}

/** Every checkout under the roots, with the GitHub repository each `origin` names. */
export async function listCheckouts(
  roots: readonly string[],
  run: CommandRunner,
): Promise<readonly NamedCheckout[]> {
  return Promise.all(
    (await crawlCheckouts(roots)).map((checkout) => describeCheckout(checkout, run)),
  );
}

async function describeCheckout(path: string, run: CommandRunner): Promise<NamedCheckout> {
  const result = await run({ argv: ["git", "-C", path, "remote", "get-url", "origin"], cwd: path });
  const repo = result.code === 0 ? githubRepoFromRemote(result.stdout) : undefined;
  return repo === undefined ? { path } : { path, repo };
}

/**
 * Clones a repository the user has no checkout of. A blobless clone keeps full history, which a
 * merge base needs, while downloading file contents only on demand.
 */
export async function cloneRepo(run: CommandRunner, repo: string, home: string): Promise<string> {
  const destination = join(home, "clones", ...repoName(repo).split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await runChecked(
    run,
    {
      argv: ["gh", "repo", "clone", repo, destination, "--", "--filter=blob:none", "--no-checkout"],
      cwd: dirname(destination),
    },
    "clone repository",
  );
  return destination;
}

/** The remote's default branch and the commit it points at, fetched just now. */
export type PinnedDefaultBranch = Readonly<{ branch: string; head: string }>;

/**
 * Fetches the remote's default branch into a Tandem-owned ref, so the user's branches,
 * remote-tracking refs, and FETCH_HEAD are untouched, and returns the commit it resolved to.
 */
export async function pinDefaultBranch(
  run: CommandRunner,
  checkout: string,
  remote: string,
): Promise<PinnedDefaultBranch> {
  const symref = await readGitText(
    run,
    checkout,
    ["ls-remote", "--symref", remote, "HEAD"],
    "git default branch lookup",
  );
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(symref)?.[1];
  if (branch === undefined) throw new Error(`${remote} does not name a default branch`);
  const ref = `refs/tandem/default/${branch}`;
  await runChecked(
    run,
    {
      argv: [
        "git",
        "-C",
        checkout,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        `+refs/heads/${branch}:${ref}`,
      ],
      cwd: checkout,
    },
    "git fetch default branch",
  );
  const head = await readGitText(
    run,
    checkout,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    "git default branch commit",
  );
  return { branch, head };
}

/** `owner/repo` from a GitHub remote URL in any of its https, ssh, or scp-like spellings. */
export function githubRepoFromRemote(url: string): string | undefined {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** Normalizes `owner/repo`, lowercased; throws on anything else. */
export function repoName(repo: string): string {
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
export async function matchingRemote(
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

/**
 * Folders holding a `.git` entry; hidden folders, `node_modules`, and symlinks are not followed.
 * Each checkout appears once, even when two roots reach it (`~/code` and `~/Code` on macOS).
 */
async function crawlCheckouts(roots: readonly string[]): Promise<readonly string[]> {
  const checkouts = new Set<string>();
  let level = roots.map((root) => resolve(root));
  for (let depth = 0; depth <= MAX_CRAWL_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const folder of level) {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.name === ".git")) {
        checkouts.add(await realpath(folder).catch(() => folder));
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
  return [...checkouts].sort();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
