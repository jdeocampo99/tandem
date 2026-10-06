import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeBoardView } from "../../src/board/native.ts";
import { type NativeTaskSummary, nativePanelView } from "../../src/board/panel.ts";
import type { BoardSnapshot } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { luauBinary } from "../luau.ts";
import { task } from "../session/fixtures.ts";
import { NOW, state, watch } from "./fixtures.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function literal(value: Json): string {
  if (value === null) return "nil";
  if (Array.isArray(value)) return `{${value.map(literal).join(",")}}`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `[${JSON.stringify(key)}]=${literal(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

test("Luau panel and board enforce unique child keys and retain actions", async () => {
  const project = "/work/app";
  const blocked = task({
    id: "blocked",
    repoPath: project,
    stage: "blocked",
    previousStage: "reviewing",
    blockReason: "Review stopped",
    pullRequest: {
      repository: "acme/app",
      number: 284,
      state: "open",
      head: "abc",
      base: "main",
    },
  });
  const snapshot: BoardSnapshot = {
    version: 1,
    writtenAt: NOW,
    board: boardView(
      state({
        tasks: [blocked],
        watches: [
          watch(
            284,
            { color: "red", status: "🔴 failing", note: "Checks failed" },
            { taskId: blocked.id },
          ),
        ],
      }),
      NOW,
    ),
    coordinators: [{ repoPath: project, project: "app", workspaceId: "2", paneId: "3" }],
  };
  const tasks: NativeTaskSummary[] = [
    {
      taskId: blocked.id,
      title: blocked.objective,
      stage: blocked.stage,
      ...(blocked.previousStage === undefined ? {} : { previousStage: blocked.previousStage }),
      createdAt: blocked.createdAt,
      updatedAt: blocked.updatedAt,
      unpricedSamples: 0,
      pullRequest: {
        repo: "acme/app",
        number: 284,
        url: "https://github.com/acme/app/pull/284",
        draft: false,
      },
    },
  ];
  const bundle = {
    panel: nativePanelView({ snapshot, project, now: NOW, tasks, bellCount: 1 }),
    board: nativeBoardView(snapshot, project, tasks, NOW),
  };
  const root = await mkdtemp(join(tmpdir(), "tandem-panel-keys-"));
  try {
    const modules = await Promise.all(
      ["panel", "board"].map(async (name) => {
        const source = await readFile(
          new URL(`../../tern-plugin/${name}.luau`, import.meta.url),
          "utf8",
        );
        return `local function load${name === "panel" ? "Panel" : "Board"}()\n${source.replaceAll("require(", "loadModule(")}\nend`;
      }),
    );
    const scenario = await readFile(new URL("./panel-keys.luau", import.meta.url), "utf8");
    const path = join(root, "panel-keys.luau");
    await writeFile(
      path,
      scenario
        .replace("-- MODULES", modules.join("\n"))
        .replace("-- MODEL", `local bundle=${literal(JSON.parse(JSON.stringify(bundle)))}`),
    );
    const child = Bun.spawn([luauBinary(), path], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("Panel and board child keys and row actions pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
