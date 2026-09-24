import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { Clock } from "../../src/contracts.ts";
import {
  githubRepoFromRemote,
  type LocateRepoOptions,
  locateRepo,
  rememberRepoLocation,
} from "../../src/repos/locate.ts";
import { readRepoLocation, withStateTransaction } from "../../src/runtime/database.ts";

const clock: Clock = () => "2030-01-01T00:00:00.000Z";
const temporaryFolders: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true })));
});

async function scratch(): Promise<{ home: string; root: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tandem-locate-")));
  temporaryFolders.push(base);
  const root = join(base, "Projects");
  await mkdir(root);
  return { home: join(base, "home"), root };
}

async function checkout(path: string, remotes: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(path, { recursive: true });
  await runCommand({ argv: ["git", "init", "-q", path], cwd: path });
  for (const [name, url] of Object.entries(remotes)) {
    await runCommand({ argv: ["git", "-C", path, "remote", "add", name, url], cwd: path });
  }
  return path;
}

function options(home: string, root: string): LocateRepoOptions {
  return { home, roots: [root], run: runCommand, clock };
}

async function saved(home: string, repo: string): Promise<string | undefined> {
  return withStateTransaction(home, (db) => readRepoLocation(db, repo));
}

test("reads owner/repo from every common GitHub remote spelling", () => {
  expect(githubRepoFromRemote("git@github.com:Acme/API.git")).toBe("acme/api");
  expect(githubRepoFromRemote("https://github.com/acme/api")).toBe("acme/api");
  expect(githubRepoFromRemote("https://github.com/acme/api.git/")).toBe("acme/api");
  expect(githubRepoFromRemote("ssh://git@github.com/acme/api.git")).toBe("acme/api");
  expect(githubRepoFromRemote("https://gitlab.com/acme/api.git")).toBeUndefined();
});

test("finds a single checkout by its remote even when the folder name differs, and saves it", async () => {
  const { home, root } = await scratch();
  const path = await checkout(join(root, "work", "backend"), {
    origin: "git@github.com:acme/api.git",
  });
  await checkout(join(root, "other"), { origin: "git@github.com:acme/web.git" });

  expect(await locateRepo("acme/api", options(home, root))).toEqual({
    kind: "found",
    path,
    remote: "origin",
  });
  expect(await saved(home, "acme/api")).toBe(path);
});

test("uses the matching remote when origin is a personal fork", async () => {
  const { home, root } = await scratch();
  await checkout(join(root, "api"), {
    origin: "git@github.com:me/api.git",
    upstream: "git@github.com:acme/api.git",
  });

  const location = await locateRepo("acme/api", options(home, root));
  expect(location).toMatchObject({ kind: "found", remote: "upstream" });
});

test("reports missing when no checkout matches, and ambiguous when several do", async () => {
  const { home, root } = await scratch();
  expect(await locateRepo("acme/api", options(home, root))).toEqual({ kind: "missing" });

  const first = await checkout(join(root, "api"), { origin: "https://github.com/acme/api" });
  const second = await checkout(join(root, "api-copy"), { origin: "https://github.com/acme/api" });
  expect(await locateRepo("acme/api", options(home, root))).toEqual({
    kind: "ambiguous",
    paths: [first, second],
  });
  expect(await saved(home, "acme/api")).toBeUndefined();
});

test("forgets a saved path whose folder is gone and crawls again", async () => {
  const { home, root } = await scratch();
  const stale = await checkout(join(root, "old"), { origin: "git@github.com:acme/api.git" });
  expect(await locateRepo("acme/api", options(home, root))).toMatchObject({ path: stale });
  await rm(stale, { recursive: true });

  expect(await locateRepo("acme/api", options(home, root))).toEqual({ kind: "missing" });
  expect(await saved(home, "acme/api")).toBeUndefined();
});

test("uses a saved path outside the crawl root without crawling", async () => {
  const { home, root } = await scratch();
  const elsewhere = await checkout(join(home, "..", "elsewhere"), {
    origin: "git@github.com:acme/api.git",
  });
  expect(await rememberRepoLocation("acme/api", elsewhere, options(home, root))).toMatchObject({
    kind: "found",
    path: elsewhere,
  });

  expect(await locateRepo("acme/api", options(home, root))).toMatchObject({ path: elsewhere });
});

test("refuses to remember a folder that is not a checkout of the repository", async () => {
  const { home, root } = await scratch();
  const wrong = await checkout(join(root, "web"), { origin: "git@github.com:acme/web.git" });

  expect(await rememberRepoLocation("acme/api", wrong, options(home, root))).toEqual({
    kind: "missing",
  });
  expect(await saved(home, "acme/api")).toBeUndefined();
});
