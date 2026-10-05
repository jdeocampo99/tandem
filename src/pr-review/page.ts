/**
 * The PR review page: one JSON input in, one self-contained HTML page plus a sibling data file
 * out, and one JSON submission back from the page. Nothing here imports Tandem's task, service,
 * or session code, so the page can become its own tool later.
 */

import {
  type BundledLanguage,
  bundledLanguages,
  bundledLanguagesInfo,
  createCssVariablesTheme,
  createHighlighter,
} from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { assemblePage, embedJson, escapeHtml } from "../pages/assemble.ts";

export type PageSeverity = "blocking" | "question" | "suggestion" | "nit";

export type TourStopInput = Readonly<{
  file: string;
  /** New-file line range, inclusive. */
  from: number;
  to: number;
  title: string;
  body: string;
}>;

export type ChapterInput = Readonly<{
  title: string;
  why: string;
  stops: readonly TourStopInput[];
}>;

export type ReviewPageInput = Readonly<{
  pr: Readonly<{
    repo: string;
    number: number;
    title: string;
    url: string;
    author: string;
    baseRef: string;
    /** The reviewed commit. */
    head: string;
  }>;
  intent: string;
  verdict?: string;
  summaryComment: string;
  chapters: readonly ChapterInput[];
  drafts: readonly Readonly<{
    id: string;
    file: string;
    line: number;
    severity: PageSeverity;
    body: string;
  }>[];
  /** Concerns with no single line; shown under "Overall concerns". */
  concerns: readonly Readonly<{ title: string; detail: string; severity: PageSeverity }>[];
  notes: readonly string[];
  /** The reviewed unified diff. */
  patch: string;
  /** Each changed file's full text at `head` and at the diff's start; a side is absent when the file does not exist there. */
  sources: Readonly<Record<string, Readonly<{ head?: string; base?: string }>>>;
}>;

export type BuiltReviewPage = Readonly<{
  html: string;
  /** JSON for the data file beside the page, fetched the first time someone expands past the embedded lines. */
  files: string;
}>;

export type SubmissionVerdict = "comment" | "approve" | "request-changes";

/** What the page's Submit sends through `window.lavish.queuePrompt`, as JSON text. */
export type ReviewSubmission = Readonly<{
  tandemPrReview: 1;
  verdict: SubmissionVerdict;
  summary: string;
  drafts: readonly Readonly<{
    id: string;
    decision: "post" | "drop" | "undecided";
    /** Present when the user edited the draft. */
    body?: string;
  }>[];
  yours: readonly Readonly<{ file: string; line: number; body: string }>[];
}>;

/** The Lavish tag and the submit control's selector, which the trust check on Tandem's side matches exactly. */
export const SUBMISSION_TAG = "tandem-pr-review";
export const SUBMIT_SELECTOR = "button#submit-review";

export type ParsedSubmission =
  | Readonly<{ ok: true; submission: ReviewSubmission }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

const PAGE_TEMPLATE_URL = new URL("./page.html", import.meta.url);

/** Lines embedded around each change; the rest of a file loads from the data file on demand. */
const EMBEDDED_LINES = 40;

const SEVERITY_ORDER: readonly PageSeverity[] = ["blocking", "question", "suggestion", "nit"];

type LineRow =
  | Readonly<{ kind: "add"; text: string; new: number }>
  | Readonly<{ kind: "del"; text: string; old: number }>
  | Readonly<{ kind: "ctx"; text: string; old: number; new: number }>;

type HunkRow = Readonly<{
  kind: "hunk";
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  label: string;
}>;

type DiffRow = LineRow | HunkRow;

type FileDiff = Readonly<{ path: string; rows: readonly DiffRow[]; adds: number; dels: number }>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Walks hunks by their declared line counts so a removed line that starts with "-- " is not
 * mistaken for a file header.
 */
function parsePatch(patch: string): FileDiff[] {
  const files: { path: string; rows: DiffRow[]; adds: number; dels: number }[] = [];
  let file: (typeof files)[number] | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\") || file === undefined) continue;
      const text = line.slice(1);
      if (line.startsWith("+") && newLeft > 0) {
        file.rows.push({ kind: "add", text, new: newNo++ });
        file.adds++;
        newLeft--;
      } else if (line.startsWith("-") && oldLeft > 0) {
        file.rows.push({ kind: "del", text, old: oldNo++ });
        file.dels++;
        oldLeft--;
      } else if (oldLeft > 0 && newLeft > 0 && (line.startsWith(" ") || line === "")) {
        file.rows.push({ kind: "ctx", text, old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const path = line.slice(line.lastIndexOf(" b/") + 3);
      file = { path, rows: [], adds: 0, dels: 0 };
      files.push(file);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null || file === undefined) continue;
    const [, oldStart, oldCount, newStart, newCount, label] = hunk;
    oldNo = Number(oldStart);
    newNo = Number(newStart);
    oldLeft = Number(oldCount ?? 1);
    newLeft = Number(newCount ?? 1);
    file.rows.push({
      kind: "hunk",
      oldStart: oldNo,
      oldCount: oldLeft,
      newStart: newNo,
      newCount: newLeft,
      label: label ?? "",
    });
  }
  return files;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

// One-letter classes keep embedded files small; the page's stylesheet colours them.
const TOKEN_CLASS: Readonly<Record<string, string>> = {
  keyword: "k",
  function: "f",
  string: "s",
  "string-expression": "s",
  constant: "c",
  parameter: "p",
  comment: "m",
  punctuation: "u",
  link: "l",
  inserted: "s",
  deleted: "d",
  changed: "p",
};

let highlighterPromise: Promise<Highlighter> | undefined;
const loadedLanguages = new Map<BundledLanguage, Promise<void>>();

function sharedHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [
      createCssVariablesTheme({ name: "tandem", variablePrefix: "--shiki-", fontStyle: true }),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function isBundled(id: string): id is BundledLanguage {
  return id in bundledLanguages;
}

function languageFor(path: string): BundledLanguage | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  const info = bundledLanguagesInfo.find(
    (language) => language.id === extension || language.aliases?.includes(extension),
  );
  return info !== undefined && isBundled(info.id) ? info.id : undefined;
}

async function loadLanguage(highlighter: Highlighter, language: BundledLanguage): Promise<void> {
  let loading = loadedLanguages.get(language);
  if (loading === undefined) {
    loading = highlighter.loadLanguage(language);
    loadedLanguages.set(language, loading);
  }
  await loading;
}

function splitLines(text: string): string[] {
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/** Highlights the whole file so multi-line strings and comments colour across lines. */
async function highlightFile(path: string, text: string): Promise<string[]> {
  const language = languageFor(path);
  if (language === undefined) return splitLines(text).map(escapeHtml);
  const highlighter = await sharedHighlighter();
  await loadLanguage(highlighter, language);
  const { tokens } = highlighter.codeToTokens(splitLines(text).join("\n"), {
    lang: language,
    theme: "tandem",
  });
  return tokens.map((line) =>
    line
      .map((token) => {
        const kind = /--shiki-token-([a-z-]+)/.exec(token.color ?? "")?.[1];
        const cls = kind === undefined ? undefined : TOKEN_CLASS[kind];
        const content = escapeHtml(token.content);
        return cls === undefined ? content : `<i class="${cls}">${content}</i>`;
      })
      .join(""),
  );
}

type Draft = ReviewPageInput["drafts"][number];

type FileView = Readonly<{
  diff: FileDiff;
  /** Section id; indexed so two paths can never collide. */
  id: string;
  head: readonly string[] | undefined;
  base: readonly string[] | undefined;
}>;

const CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;
const EXPAND = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>`;

const baseName = (path: string) => path.split("/").pop() ?? path;
const dirName = (path: string) => path.split("/").slice(0, -1).join("/");
const md = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function draftCard(draft: Draft, inline: boolean): string {
  const where = `<button class="loc" data-file="${escapeHtml(draft.file)}" data-line="${draft.line}">${escapeHtml(baseName(draft.file))}:${draft.line}</button>`;
  return `<article class="draft ${inline ? "inline" : "side"}" data-draft="${escapeHtml(draft.id)}" data-state="pending" data-body="${escapeHtml(draft.body)}" data-original="${escapeHtml(draft.body)}">
<header><span class="by"><i class="mark">T</i>Tandem</span><span class="sev" data-sev="${draft.severity}">${draft.severity}</span>${inline ? "" : where}<span class="state"></span></header>
<p>${md(draft.body)}</p>
<footer><button class="link approve" data-act="approve">Add to review</button><button class="link" data-act="skip">Dismiss</button><button class="link" data-act="edit">Edit</button></footer>
</article>`;
}

type Gap = Readonly<{
  from: number;
  to: number;
  /** Old line number minus new line number across the gap. */
  delta: number;
  dir: "up" | "down";
  label: string;
}>;

/** Renders a hidden-lines row and records the lines nearest the change into `near`. */
function gapRow(view: FileView, gap: Gap, near: Record<number, string>): string {
  const hidden = gap.to - gap.from + 1;
  if (hidden <= 0 || view.head === undefined) return "";
  const embedded = Math.min(hidden, EMBEDDED_LINES);
  const [first, last] =
    gap.dir === "up" ? [gap.to - embedded + 1, gap.to] : [gap.from, gap.from + embedded - 1];
  for (let line = first; line <= last; line++) near[line] = view.head[line - 1] ?? "";
  const label = gap.label === "" ? "" : `<span class="ctx">${escapeHtml(gap.label)}</span>`;
  return `<tr class="gap" data-from="${gap.from}" data-to="${gap.to}" data-delta="${gap.delta}" data-dir="${gap.dir}"><td colspan="2" class="gap-btn"><button class="exp" data-expand="20" title="Show 20 more lines">${EXPAND}</button></td><td class="gap-label"><button class="exp-all" data-expand="all"><span class="n">${hidden}</span> <span class="w">hidden line${hidden === 1 ? "" : "s"}</span></button>${label}</td></tr>`;
}

function codeHtml(view: FileView, row: LineRow): string {
  const highlighted = row.kind === "del" ? view.base?.[row.old - 1] : view.head?.[row.new - 1];
  return highlighted ?? escapeHtml(row.text);
}

function renderFile(
  view: FileView,
  drafts: readonly Draft[],
  near: Record<string, Record<number, string>>,
): string {
  const { diff } = view;
  const fileNear: Record<number, string> = {};
  let body = "";
  let prevNewEnd = 0;
  let prevDelta = 0;
  for (const row of diff.rows) {
    if (row.kind === "hunk") {
      body += gapRow(
        view,
        {
          from: prevNewEnd + 1,
          to: row.newStart - 1,
          delta: row.oldStart - row.newStart,
          dir: "up",
          label: row.label,
        },
        fileNear,
      );
      prevDelta = row.oldStart + row.oldCount - (row.newStart + row.newCount);
      continue;
    }
    if (row.kind !== "del") prevNewEnd = row.new;
    // Only new-side lines inside hunks take a comment: those are the lines GitHub accepts one on.
    const commentable = row.kind !== "del";
    const oldNo = row.kind === "add" ? "" : row.old;
    const newNo = row.kind === "del" ? "" : row.new;
    const id = commentable ? ` id="${view.id}-L${row.new}"` : "";
    const hook = commentable
      ? `<td class="no hook" data-lavish-action>${newNo}</td>`
      : `<td class="no"></td>`;
    body += `<tr class="${row.kind}"${id} data-line="${commentable ? row.new : ""}"><td class="no">${oldNo}</td>${hook}<td class="code">${codeHtml(view, row) || " "}</td></tr>`;
    if (row.kind === "del") continue;
    for (const draft of drafts) {
      if (draft.file === diff.path && draft.line === row.new) {
        body += `<tr class="note"><td colspan="3">${draftCard(draft, true)}</td></tr>`;
      }
    }
  }
  if (view.head !== undefined) {
    body += gapRow(
      view,
      { from: prevNewEnd + 1, to: view.head.length, delta: prevDelta, dir: "down", label: "" },
      fileNear,
    );
  }
  if (Object.keys(fileNear).length > 0) near[diff.path] = fileNear;
  const n = drafts.filter((draft) => draft.file === diff.path).length;
  const dir = dirName(diff.path);
  return `<section class="file panel" id="${view.id}" data-path="${escapeHtml(diff.path)}" data-expanded="true">
<div class="file-head"><button class="fold" aria-expanded="true" title="Collapse file">${CHEVRON}</button><button class="path" data-fold>${dir === "" ? "" : `<span class="dir">${escapeHtml(dir)}/</span>`}${escapeHtml(baseName(diff.path))}</button>${n > 0 ? `<span class="tag">${plural(n, "draft", "drafts")}</span>` : ""}<span class="stat num"><span class="plus">+${diff.adds}</span> <span class="minus">−${diff.dels}</span></span>
<label class="viewed"><input type="checkbox" name="viewed" data-viewed="${escapeHtml(diff.path)}"> Viewed</label></div>
<div class="drawer"><div><table class="diff"><colgroup><col class="c-no"><col class="c-no"><col></colgroup><tbody>${body}</tbody></table></div></div></section>`;
}

function renderTree(views: readonly FileView[], drafts: readonly Draft[]): string {
  const groups = new Map<string, FileView[]>();
  for (const view of views) {
    const dir = dirName(view.diff.path);
    groups.set(dir, [...(groups.get(dir) ?? []), view]);
  }
  const hasDraft = (path: string) => drafts.some((draft) => draft.file === path);
  return [...groups]
    .map(([dir, members]) => {
      const label = dir === "" ? "(root)" : dir;
      const dot = members.some((view) => hasDraft(view.diff.path))
        ? '<span class="dot"></span>'
        : "";
      const buttons = members
        .map(({ diff }) => {
          const mark = hasDraft(diff.path) ? '<span class="dot" title="Has a draft"></span>' : "";
          return `<button class="res tree-file" data-open="${escapeHtml(diff.path)}"><span class="tick"></span><b>${escapeHtml(baseName(diff.path))}</b>${mark}<span class="stat num"><span class="plus">+${diff.adds}</span> <span class="minus">−${diff.dels}</span></span></button>`;
        })
        .join("");
      return `<div class="dir" data-collapsed="false"><button class="dir-label" title="${escapeHtml(label)}"><span class="chev">${CHEVRON}</span><span class="dname">${escapeHtml(label)}</span>${dot}<span class="dcount num">${members.length}</span></button><div class="dir-files"><div>${buttons}</div></div></div>`;
    })
    .join("");
}

type TourStop = TourStopInput & Readonly<{ chapter: number; hasDraft: boolean }>;

function flattenTour(chapters: readonly ChapterInput[], drafts: readonly Draft[]): TourStop[] {
  return chapters.flatMap((chapter, index) =>
    chapter.stops.map((stop) => ({
      ...stop,
      chapter: index,
      hasDraft: drafts.some(
        (draft) => draft.file === stop.file && draft.line >= stop.from && draft.line <= stop.to,
      ),
    })),
  );
}

function renderWalkthrough(chapters: readonly ChapterInput[], tour: readonly TourStop[]): string {
  if (tour.length === 0) return "";
  const letter = (index: number) => String.fromCharCode(65 + index);
  const rows = chapters
    .map((chapter, index) => {
      const files = [...new Set(chapter.stops.map((stop) => stop.file))];
      if (files.length === 0) return "";
      const boxes = files
        .map((file) => {
          const dir = dirName(file);
          return `<button class="fbox" data-chapter="${index}" data-file="${escapeHtml(file)}" title="${escapeHtml(file)}"><b>${escapeHtml(baseName(file))}</b>${dir === "" ? "" : `<small>${escapeHtml(dir)}</small>`}</button>`;
        })
        .join('<span class="flow-arrow" aria-hidden="true">→</span>');
      return `<div class="flow-row"><div class="flow-label"><b>${letter(index)}</b>${escapeHtml(chapter.title)}</div><div class="flow-boxes">${boxes}</div></div>`;
    })
    .join("");
  const list = chapters
    .map((chapter, index) => {
      const first = tour.findIndex((stop) => stop.chapter === index);
      if (first < 0) return "";
      const count = tour.filter((stop) => stop.chapter === index).length;
      return `<div class="ch-row"><span class="ch-n num">${letter(index)}</span><div><b>${escapeHtml(chapter.title)}</b><small>${escapeHtml(chapter.why)}</small></div><span class="count">${plural(count, "stop", "stops")}</span><button class="link" data-tour="${first}">Walk through</button></div>`;
    })
    .join("");
  return `<section class="sec">
<header class="sec-h"><span class="sec-n num">02</span><div><h2>Code walkthrough</h2><p class="sec-note">Select a file for its explanation. Start the tour to step through all ${tour.length} stops in order.</p></div><button class="primary" data-tour="0">Start tour</button></header>
<div class="panel flow">${rows}<div class="pop" id="pop" hidden></div></div>
<div class="panel chlist">${list}</div>
</section>`;
}

function renderSummary(input: ReviewPageInput, files: readonly FileDiff[]): string {
  const adds = files.reduce((sum, file) => sum + file.adds, 0);
  const dels = files.reduce((sum, file) => sum + file.dels, 0);
  const { pr } = input;
  const meta = `<p class="meta-line"><b>${escapeHtml(pr.author)}</b> wants to merge into <span class="num">${escapeHtml(pr.baseRef)}</span> · <span class="num">${escapeHtml(pr.head.slice(0, 7))}</span> · <span class="num"><span class="plus">+${adds}</span> <span class="minus">−${dels}</span></span> across ${plural(files.length, "file", "files")}</p>`;
  const intent = input.intent
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim() !== "")
    .map((paragraph) => `<p class="lead">${md(paragraph.trim())}</p>`)
    .join("\n");
  const verdict =
    input.verdict === undefined || input.verdict.trim() === ""
      ? ""
      : `<p class="take"><b>Verdict:</b> ${md(input.verdict)}</p>`;
  const notes = input.notes.map((note) => `<p class="notes-line">${md(note)}</p>`).join("\n");
  return [meta, intent, verdict, notes].filter((part) => part !== "").join("\n");
}

function renderConcerns(concerns: ReviewPageInput["concerns"]): string {
  if (concerns.length === 0) return "";
  const rows = concerns
    .map(
      (concern) =>
        `<div class="orow"><span class="sev" data-sev="${concern.severity}">${concern.severity}</span><b>${escapeHtml(concern.title)}</b><p>${md(concern.detail)}</p></div>`,
    )
    .join("");
  return `<h3><span>Overall concerns</span></h3>\n<div class="panel list">${rows}</div>`;
}

/** Builds the page and its data file from one input. */
export async function buildReviewPage(
  input: ReviewPageInput,
  filesHref: string,
): Promise<BuiltReviewPage> {
  const diffs = parsePatch(input.patch);
  const views: FileView[] = [];
  const headLines: Record<string, string[]> = {};
  for (const [index, diff] of diffs.entries()) {
    const source = input.sources[diff.path];
    const head =
      source?.head === undefined ? undefined : await highlightFile(diff.path, source.head);
    // The base side only supplies removed lines.
    const base =
      source?.base === undefined || diff.dels === 0
        ? undefined
        : await highlightFile(diff.path, source.base);
    if (head !== undefined) headLines[diff.path] = head;
    views.push({ diff, id: `f${index}`, head, base });
  }

  const near: Record<string, Record<number, string>> = {};
  const changes = views.map((view) => renderFile(view, input.drafts, near)).join("\n");
  const tour = flattenTour(input.chapters, input.drafts);
  const sorted = [...input.drafts].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const { pr } = input;

  const html = assemblePage(PAGE_TEMPLATE_URL, {
    title: escapeHtml(`Review #${pr.number}`),
    number: String(pr.number),
    prtitle: escapeHtml(pr.title),
    prurl: escapeHtml(pr.url),
    filecount: String(diffs.length),
    tree: renderTree(views, input.drafts),
    summary: renderSummary(input, diffs),
    walkthrough: renderWalkthrough(input.chapters, tour),
    changes,
    concerns: renderConcerns(input.concerns),
    sidedrafts: sorted.map((draft) => draftCard(draft, false)).join(""),
    summarycomment: escapeHtml(input.summaryComment),
    data: `<script type="application/json" id="page-data">${embedJson({
      pr: { url: pr.url, number: pr.number, head: pr.head },
      filesHref,
      tour,
      chapters: input.chapters.map(({ title, why }) => ({ title, why })),
      near,
    })}</script>`,
  });
  return { html, files: JSON.stringify(headLines) };
}

const VERDICTS: readonly SubmissionVerdict[] = ["comment", "approve", "request-changes"];
const DECISIONS = ["post", "drop", "undecided"] as const;

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: JsonObject, allowed: readonly string[], where: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: unknown key "${key}"`);
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** Reads the page's submission JSON text, naming every problem instead of throwing. */
export function parseReviewSubmission(text: string): ParsedSubmission {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The submission is not valid JSON."] };
  }
  if (!isObject(raw)) return { ok: false, problems: ["The submission must be a JSON object."] };

  const problems = unknownKeys(
    raw,
    ["tandemPrReview", "verdict", "summary", "drafts", "yours"],
    "submission",
  );
  if (raw.tandemPrReview !== 1) problems.push("submission: tandemPrReview must be 1.");
  const verdict = VERDICTS.find((candidate) => candidate === raw.verdict);
  if (verdict === undefined) {
    problems.push(`submission: verdict must be one of ${VERDICTS.join(", ")}.`);
  }
  if (typeof raw.summary !== "string") problems.push("submission: summary must be a string.");

  const drafts: ReviewSubmission["drafts"][number][] = [];
  if (!Array.isArray(raw.drafts)) {
    problems.push("submission: drafts must be an array.");
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of raw.drafts.entries()) {
      const where = `drafts[${index}]`;
      if (!isObject(entry)) {
        problems.push(`${where}: must be an object.`);
        continue;
      }
      problems.push(...unknownKeys(entry, ["id", "decision", "body"], where));
      const decision = DECISIONS.find((candidate) => candidate === entry.decision);
      if (!isText(entry.id)) problems.push(`${where}: id must be a non-empty string.`);
      else if (seen.has(entry.id)) problems.push(`${where}: duplicate id "${entry.id}".`);
      else seen.add(entry.id);
      if (decision === undefined) {
        problems.push(`${where}: decision must be one of ${DECISIONS.join(", ")}.`);
      }
      if (entry.body !== undefined && !isText(entry.body)) {
        problems.push(`${where}: body must be a non-empty string when present.`);
      }
      if (isText(entry.id) && decision !== undefined) {
        drafts.push({
          id: entry.id,
          decision,
          ...(isText(entry.body) ? { body: entry.body } : {}),
        });
      }
    }
  }

  const yours: ReviewSubmission["yours"][number][] = [];
  if (!Array.isArray(raw.yours)) {
    problems.push("submission: yours must be an array.");
  } else {
    for (const [index, entry] of raw.yours.entries()) {
      const where = `yours[${index}]`;
      if (!isObject(entry)) {
        problems.push(`${where}: must be an object.`);
        continue;
      }
      problems.push(...unknownKeys(entry, ["file", "line", "body"], where));
      if (!isText(entry.file)) problems.push(`${where}: file must be a non-empty string.`);
      if (typeof entry.line !== "number" || !Number.isInteger(entry.line) || entry.line < 1) {
        problems.push(`${where}: line must be a positive integer.`);
      }
      if (!isText(entry.body)) problems.push(`${where}: body must be a non-empty string.`);
      if (
        isText(entry.file) &&
        typeof entry.line === "number" &&
        Number.isInteger(entry.line) &&
        entry.line >= 1 &&
        isText(entry.body)
      ) {
        yours.push({ file: entry.file, line: entry.line, body: entry.body });
      }
    }
  }

  if (problems.length > 0 || verdict === undefined || typeof raw.summary !== "string") {
    return { ok: false, problems };
  }
  return {
    ok: true,
    submission: { tandemPrReview: 1, verdict, summary: raw.summary, drafts, yours },
  };
}
