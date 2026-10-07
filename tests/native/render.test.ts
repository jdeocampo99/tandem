import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeViewsPublication } from "../../src/board/native-views.ts";
import { blockArgs, setupFile, ViewFile } from "../../src/native/contract.ts";
import { publishViews, viewDetailPath, viewIndexPath } from "../../src/native/store.ts";
import { parseSetupAnswer } from "../../src/onboarding/setup-answer.ts";
import { SETUP_MODES, type SetupMode } from "../../src/onboarding/setup-view.ts";
import { BUILT_IN_SPECIALISTS } from "../../src/specialists/built-in.ts";
import { specialistFields, specialistMarkdown } from "../../src/specialists/specialist.ts";
import { luauBinary } from "../luau.ts";
import { setupViewFixture } from "../onboarding/setup-fixture.ts";
import { taskScreenPublication } from "../tasks/task-screen-fixture.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";

const PLUGIN = fileURLToPath(new URL("../../tern-plugin/", import.meta.url));
const DRIVER = fileURLToPath(new URL("./render.luau", import.meta.url));
const JSON_CODEC = fileURLToPath(new URL("../evals/tern-parity/json.luau", import.meta.url));

type Node = Readonly<{ k: string; p?: Record<string, unknown>; c?: readonly Node[] | object }>;
type Drawn = Readonly<{
  title?: string;
  tree?: Record<string, Node>;
  error?: string;
  /** What the block sent to `tandem native act` in this step. */
  sent?: readonly string[];
}>;
type Case = Readonly<{
  block: string;
  args: readonly string[];
  steps: readonly Readonly<Record<string, string | false>>[];
}>;

let home: string;
let project: string;
let files: Record<
  "index" | "task" | "brief" | "pr",
  { path: string; text: string; file: ViewFile }
>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "tdm-render-"));
  project = join(home, "repo");
  const fixture = taskScreenPublication(project);
  const screens = nativeScreensFixture();
  const publication: NativeViewsPublication = {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      board: screens.board,
      usage: screens.usage,
      catchup: { ...screens.catchup, project },
    },
  };
  await publishViews(home, project, async () => publication);
  const views = join(home, "tern");
  expect((await readdir(views)).length).toBe(1);
  const read = async (path: string) => {
    const text = await readFile(path, "utf8");
    return { path, text, file: ViewFile.parse(JSON.parse(text)) };
  };
  files = {
    index: await read(viewIndexPath(home, project)),
    task: await read(viewDetailPath(home, project, "task-102.json")),
    brief: await read(viewDetailPath(home, project, "brief-req-tern.json")),
    pr: await read(viewDetailPath(home, project, "pr-owner%2Frepo-281.json")),
  };
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function args(viewPath: string): string[] {
  return blockArgs(viewPath, {
    coordinator: "20",
    cwd: project,
    home,
    index: viewIndexPath(home, project),
  });
}

/** The same file with `model` replaced and `seq` moved by `step`. */
function rewrite(kind: keyof typeof files, model: unknown, step = 1, epoch?: string): string {
  const { file } = files[kind];
  return JSON.stringify({ ...file, epoch: epoch ?? file.epoch, seq: file.seq + step, model });
}

function text(node: Node | undefined): string[] {
  if (node === undefined) return [];
  const own = ["text", "label", "placeholder"].flatMap((key) => {
    const value = node.p?.[key];
    return typeof value === "string" && value !== "" ? [value] : [];
  });
  // The JSON encoder writes an empty child list as `{}`.
  return [...own, ...(Array.isArray(node.c) ? node.c.flatMap(text) : [])];
}

function strings(drawn: Drawn): string[] {
  expect(drawn.error).toBeUndefined();
  return ["layer", "main", "dock"].flatMap((slot) => text(drawn.tree?.[slot]));
}

async function render(cases: readonly Case[]): Promise<Drawn[][]> {
  const lua = (value: unknown): string => {
    if (typeof value === "string") {
      let level = "";
      while (value.includes(`]${level}]`)) level += "=";
      return `[${level}[\n${value}]${level}]`;
    }
    if (typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return `{${value.map(lua).join(",")}}`;
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `[ ${lua(key)} ]=${lua(entry)}`)
      .join(",")}}`;
  };
  const modules: Record<string, string> = {};
  for (const name of await readdir(PLUGIN))
    if (name.endsWith(".luau"))
      modules[`./${name.slice(0, -5)}`] = await readFile(join(PLUGIN, name), "utf8");
  const source = `${await readFile(JSON_CODEC, "utf8")}\nlocal MODULES = ${lua(modules)}\nlocal CASES = ${lua(cases)}\n${await readFile(DRIVER, "utf8")}`;
  const script = join(home, "render.luau");
  await Bun.write(script, source);
  const child = Bun.spawn([luauBinary(), script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const drawn: Drawn[][] = cases.map(() => []);
  for (const line of stdout.split("\n")) {
    const match = /^@@(\d+)\t(\d+)\t(.*)$/u.exec(line);
    if (match === null) continue;
    drawn[Number(match[1]) - 1]?.push(JSON.parse(match[3] ?? "") as Drawn);
  }
  return drawn;
}

test("every view the store writes draws through its real screen", async () => {
  const index = files.index.path;
  const shown = await render([
    { block: "panel", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "board", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "usage", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "catchup", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "task-picker", args: args(index), steps: [{ [index]: files.index.text }] },
    {
      block: "task",
      args: args(files.task.path),
      steps: [{ [index]: files.index.text, [files.task.path]: files.task.text }],
    },
    {
      block: "brief",
      args: args(files.brief.path),
      steps: [{ [index]: files.index.text, [files.brief.path]: files.brief.text }],
    },
    {
      block: "pr",
      args: args(files.pr.path),
      steps: [{ [index]: files.index.text, [files.pr.path]: files.pr.text }],
    },
  ]);
  const [panel, board, usage, catchup, picker, task, brief, pr] = shown.map((steps) => {
    const [first] = steps;
    if (first === undefined) throw new Error("block drew nothing");
    return first;
  });
  expect(strings(panel ?? {})).toEqual([
    "tandem",
    "5h unavailable",
    "🔔︎ 0",
    "⎇",
    "▦",
    "⚙",
    "Needs you · 0",
    "Running · 1",
    "●",
    "Tern backend adapter",
    "fixing",
    "12m",
    "opus · editing adapter.ts",
    "Ready · 0",
    "Recently done · 0",
  ]);
  expect(strings(board ?? {})).toEqual(expect.arrayContaining(["● Working", "● Ready to merge"]));
  expect(strings(usage ?? {})).toEqual(expect.arrayContaining(["5-hour window", "Weekly"]));
  expect(strings(catchup ?? {})).toEqual(
    expect.arrayContaining([
      "Since you left",
      "Approve brief: Tern backend: brief waiting for approval",
    ]),
  );
  expect(strings(picker ?? {})).toEqual(
    expect.arrayContaining(["Tern backend adapter", "Fix the settings page"]),
  );
  expect(task?.title).toBe("Tern backend adapter");
  expect(strings(task ?? {})).toContain("task #102");
  expect(strings(task ?? {})).not.toContain(
    "Saved view unavailable. Actions are disabled until fresh data arrives.",
  );
  expect(brief?.title).toBe("Brief · Request brief");
  expect(strings(brief ?? {})).toEqual(expect.arrayContaining(["Approve"]));
  expect(pr?.title).toBe("#281 ▾");
});

test("a model that cannot draw keeps the last good one and shows the unavailable state", async () => {
  const index = files.index.path;
  const realModel = files.index.file.model;
  const [panel, fresh, wrongKind, task, brief, pr] = await render([
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: files.index.text },
        { [index]: rewrite("index", { panel: { header: 7 } }) },
        { [index]: files.index.text },
        { [index]: "{broken" },
        { [index]: rewrite("index", realModel, 1, "a-new-store") },
        { [index]: false },
      ],
    },
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: rewrite("index", { panel: [] }) },
        { [index]: rewrite("index", realModel, 2) },
      ],
    },
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: files.index.text },
        {
          [index]: JSON.stringify({
            ...files.index.file,
            kind: "task",
            seq: files.index.file.seq + 1,
          }),
        },
      ],
    },
    {
      block: "task",
      args: args(files.task.path),
      steps: [
        { [index]: files.index.text, [files.task.path]: rewrite("task", { header: {} }) },
        { [files.task.path]: rewrite("task", files.task.file.model, 2) },
      ],
    },
    {
      block: "brief",
      args: args(files.brief.path),
      steps: [
        { [files.brief.path]: files.brief.text },
        { [files.brief.path]: rewrite("brief", { title: "Broken", lines: 3 }) },
        { [files.brief.path]: rewrite("brief", files.brief.file.model, 2) },
      ],
    },
    {
      block: "pr",
      args: args(files.pr.path),
      steps: [
        { [index]: files.index.text, [files.pr.path]: files.pr.text },
        { [files.pr.path]: rewrite("pr", { header: { number: 9 }, files: 4 }) },
      ],
    },
  ]);
  const unavailable = "View unavailable · actions paused";
  const [good, broken, older, torn, newStore, missing] = (panel ?? []).map(strings);
  expect(good).not.toContain(unavailable);
  expect(broken).toEqual([...(good ?? []).slice(0, 6), unavailable, ...(good ?? []).slice(6)]);
  // An older `seq` from the same store never replaces what is shown.
  expect(older).toEqual(broken);
  expect(torn).toEqual(broken);
  expect(newStore).toEqual(good);
  expect(missing).toEqual(broken);

  const [never, recovered] = (fresh ?? []).map(strings);
  expect(never).toEqual(["Waiting for Tandem's project snapshot…"]);
  expect(recovered).toEqual(good);

  // A newer file of another kind is not this block's view, however well its model draws.
  expect((wrongKind ?? []).map(strings)).toEqual([good ?? [], broken ?? []]);

  const [taskBroken, taskGood] = task ?? [];
  expect(strings(taskBroken ?? {})).toEqual([
    "Task unavailable",
    "← Orchestrator",
    "Task view unavailable. Waiting for its saved detail file.",
  ]);
  expect(strings(taskGood ?? {})).toContain("task #102");

  const [briefGood, briefBroken, briefNext] = (brief ?? []).map(strings);
  expect(briefGood).toContain("Approve");
  expect(briefBroken).toContain(
    "Brief unavailable. Actions are disabled until the view file recovers.",
  );
  expect(briefBroken).not.toContain("Approve");
  expect(briefBroken).toContain(briefGood?.find((line) => line.startsWith("Brief · ")));
  expect(briefNext).toContain("Approve");

  const [prGood, prBroken] = pr ?? [];
  expect(strings(prGood ?? {})).toContain("#281 ▾");
  expect(prBroken?.title).toBe("#281 ▾");
  expect(strings(prBroken ?? {})).toContain("#281 ▾");
});

test("the setup block draws the published setup and settings views", async () => {
  const shown: Record<SetupMode, string[]> = { setup: [], settings: [] };
  for (const mode of SETUP_MODES) {
    await publishViews(home, project, async () => ({ setup: setupViewFixture(mode) }));
    const path = viewDetailPath(home, project, setupFile(mode));
    const [drawn] = await render([
      { block: "setup", args: args(path), steps: [{ [path]: await readFile(path, "utf8") }] },
    ]);
    shown[mode] = strings(drawn?.at(-1) ?? {});
  }
  expect(shown.setup).toContain("Set up Tandem");
  expect(shown.setup).toContain("Customize");
  expect(shown.settings).toContain("Settings");
  expect(shown.settings).not.toContain("Customize");
});

/** Whether the block draws an enabled control labelled `label` that sends `action`. */
function enabled(drawn: Drawn, label: string, action: string): boolean {
  const find = (node: Node | undefined): boolean => {
    if (node === undefined) return false;
    const actions = node.p?.actions as Readonly<{ click?: string }> | undefined;
    if (node.p?.text === label && actions?.click === action) return true;
    return Array.isArray(node.c) && node.c.some(find);
  };
  return ["main", "dock"].some((slot) => find(drawn.tree?.[slot]));
}

/** The setup answer the block sent with Save. */
function sentAnswer(drawn: Drawn | undefined): unknown {
  const [stdin] = drawn?.sent ?? [];
  const envelope = JSON.parse(stdin ?? "null") as { action: { verb: string; answer: unknown } };
  expect(envelope.action.verb).toBe("setup-save");
  return envelope.action.answer;
}

async function settingsFile(): Promise<Readonly<{ path: string; text: string }>> {
  await publishViews(home, project, async () => ({ setup: setupViewFixture("settings") }));
  const path = viewDetailPath(home, project, setupFile("settings"));
  return { path, text: await readFile(path, "utf8") };
}

test("Settings › Specialists lists every source and saves a new specialist only once it is valid", async () => {
  const { path, text: file } = await settingsFile();
  const [steps = []] = await render([
    {
      block: "setup",
      args: args(path),
      steps: [
        { [path]: file },
        { "@act": "go=specialists" },
        { "@act": "sp-new" },
        { "@type": "release-notes" },
        { "@type": "-weekly" },
        { "@focus": "sp-label", "@type": "Weekly notes" },
        { "@focus": "sp-instr", "@type": "Group merged PRs by area." },
        { "@act": "sp-step-add" },
        { "@type": "Collect merged PRs" },
        { "@act": "sp-step-add" },
        { "@type": "Collect merged PRs" },
        { "@act": "sp-step-rm=2" },
        { "@act": "send" },
      ],
    },
  ]);
  const list = strings(steps[1] ?? {});
  for (const shown of [
    "+ New specialist",
    "TEAM · .tandem/specialists",
    "JUST ME · ~/.tandem/specialists",
    "BUILT-IN",
    "Blog writer",
    "A post about a shipped feature",
    "Only when named",
    "Replaces built-in",
    "Replaced by yours",
    'line 3: unknown key "model"; a specialist\'s keys are name, label, description',
    "Where they come from",
  ])
    expect(list).toContain(shown);
  expect(strings(steps[2] ?? {})).toContain("Not saved yet");

  const taken = steps[3] ?? {};
  expect(strings(taken)).toContain("You already have a specialist named release-notes.");
  expect(strings(taken)).toContain(
    "release-notes: You already have a specialist named release-notes.",
  );
  expect(enabled(taken, "Save changes", "send")).toBe(false);

  const repeated = steps[10] ?? {};
  expect(strings(repeated)).toContain("release-notes-weekly: Same as step 1.");
  expect(enabled(repeated, "Save changes", "send")).toBe(false);
  expect(enabled(steps[11] ?? {}, "Save changes", "send")).toBe(true);

  const parsed = parseSetupAnswer(JSON.stringify(sentAnswer(steps[12])));
  if (!parsed.ok) throw new Error(parsed.problems.join(" "));
  const fields = {
    label: "Weekly notes",
    instructions: "Group merged PRs by area.",
    steps: ["Collect merged PRs"],
  };
  expect(parsed.answer.specialists).toEqual([
    { op: "create", name: "release-notes-weekly", fields },
  ]);
  expect(specialistMarkdown("release-notes-weekly", fields).ok).toBe(true);
});

test("Settings › Specialists edits, removes and customizes in one answer, and drops what a newer file shows saved", async () => {
  const { path, text: file } = await settingsFile();
  const published = JSON.parse(file) as {
    seq: number;
    model: { specialists: { rows: unknown[] } };
  };
  const feature = BUILT_IN_SPECIALISTS.find((specialist) => specialist.name === "feature");
  if (feature === undefined) throw new Error("missing built-in feature");
  const saved = {
    ...published,
    seq: published.seq + 1,
    model: {
      ...published.model,
      specialists: {
        ...published.model.specialists,
        rows: [
          ...published.model.specialists.rows,
          {
            name: "feature",
            origin: "home",
            state: "ready",
            status: { text: "Replaces built-in", tone: "info" },
            shownPath: "~/.tandem/specialists/feature.md",
            revision: "c".repeat(64),
            summary: feature.description ?? "Only when named",
            fields: specialistFields(feature),
          },
        ],
      },
    },
  };
  const [steps = []] = await render([
    {
      block: "setup",
      args: args(path),
      steps: [
        { [path]: file },
        { "@act": "go=specialists" },
        { "@act": "sp=team:blog-writer" },
        { "@act": "sp=home:release-notes" },
        { "@focus": "sp-label", "@type": " v2" },
        { "@act": "sp=home:bug-fix" },
        { "@act": "sp-remove" },
        { "@act": "sp=built-in:feature" },
        { "@act": "sp-customize" },
        { "@act": "send" },
        { [path]: JSON.stringify(saved) },
      ],
    },
  ]);
  const team = strings(steps[2] ?? {});
  expect(team).toContain("Shared through the repository. Changes go through a pull request.");
  expect(team).not.toContain("Remove");
  expect(strings(steps[3] ?? {})).toContain("locked");
  expect(strings(steps[4] ?? {})).toContain("Unsaved changes");
  expect(strings(steps[6] ?? {})).toContain("Will be removed when you save.");
  expect(enabled(steps[7] ?? {}, "Customize", "sp-customize")).toBe(true);
  expect(strings(steps[8] ?? {})).toContain("Not saved yet");

  const parsed = parseSetupAnswer(JSON.stringify(sentAnswer(steps[9])));
  if (!parsed.ok) throw new Error(parsed.problems.join(" "));
  expect(parsed.answer.specialists).toEqual([
    { op: "create", name: "feature", fields: specialistFields(feature) },
    {
      op: "update",
      name: "release-notes",
      revision: "a".repeat(64),
      fields: {
        label: "Release notes v2",
        instructions: "Short and user-facing.",
        steps: ["Collect merged PRs"],
      },
    },
    { op: "remove", name: "bug-fix", revision: "b".repeat(64) },
  ]);

  // The newer file has the saved copy of feature: it leaves the unsaved list and stays selected.
  const after = strings(steps[10] ?? {});
  expect(after).not.toContain("Not saved yet");
  expect(after).toContain("locked");
  expect(after).toContain("Unsaved changes");
});
