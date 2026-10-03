import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LaunchIo } from "./contract.ts";

async function answersHealth(socket: string): Promise<boolean> {
  try {
    return (await fetch("http://sidecar/health", { unix: socket })).ok;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The real effects a launch lends its harness; tests replace the ones they script. */
export function launchIo(
  overrides: Pick<LaunchIo, "sleep"> & Partial<Pick<LaunchIo, "newId" | "answersHealth" | "now">>,
): LaunchIo {
  return {
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    },
    newId: overrides.newId ?? randomUUID,
    answersHealth: overrides.answersHealth ?? answersHealth,
    sleep: overrides.sleep,
    now: overrides.now ?? (() => performance.now()),
  };
}
