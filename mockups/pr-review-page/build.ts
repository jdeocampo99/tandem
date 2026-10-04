const dir = import.meta.dir;
const patch = await Bun.file(`${dir}/pr266.patch`).text();

type Row = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number };
type FileDiff = { path: string; rows: Row[]; adds: number; dels: number };

function parsePatch(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: line.split(" b/")[1] ?? "", rows: [], adds: 0, dels: 0 };
      files.push(file);
    } else if (!file || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename)/.test(line)) {
    } else if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldNo = Number(m?.[1]);
      newNo = Number(m?.[2]);
      file.rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      file.rows.push({ kind: "add", text: line.slice(1), new: newNo++ });
      file.adds++;
    } else if (line.startsWith("-")) {
      file.rows.push({ kind: "del", text: line.slice(1), old: oldNo++ });
      file.dels++;
    } else if (line.startsWith(" ")) {
      file.rows.push({ kind: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ });
    }
  }
  return files;
}

const files = parsePatch(patch);
const fileId = (path: string) => `f-${path.replace(/[^A-Za-z0-9]/g, "-")}`;
const lineId = (path: string, n: number) => `${fileId(path)}-L${n}`;
const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function lineOf(path: string, needle: string): number {
  const row = files.find((f) => f.path === path)?.rows.find((r) => r.new !== undefined && r.text.includes(needle));
  if (row?.new === undefined) throw new Error(`no line in ${path} matching ${needle}`);
  return row.new;
}

type Draft = { id: string; file: string; line: number; severity: string; body: string };
const drafts: Draft[] = [
  {
    id: "c1",
    file: "src/harness/claude-code/launch.ts",
    line: lineOf("src/harness/claude-code/launch.ts", 'cwd.replace(/[^A-Za-z0-9]/gu, "-")'),
    severity: "question",
    body: "This copies Claude Code's folder naming (checked on 2.1.289). If a later version changes it, `exists` returns false for a saved conversation, `chooseConversation` picks `--session-id`, and Claude Code refuses the id because a transcript exists. Should a refused `--session-id` fall back to `--resume` instead of failing the launch?",
  },
  {
    id: "c2",
    file: "src/harness/launch-io.ts",
    line: lineOf("src/harness/launch-io.ts", "() => false,"),
    severity: "suggestion",
    body: "Every `access` error reads as \"not saved\", including EACCES. A permission error would then start a fresh conversation under the same id. Treat only ENOENT as missing, as `isMissing` already does above.",
  },
  {
    id: "c3",
    file: "src/harness/claude-code/worker.ts",
    line: lineOf("src/harness/claude-code/worker.ts", 'event.origin === "task-notification" && session.reportSubmitted'),
    severity: "nit",
    body: "The comment says OMP aborts that wake. A one-line pointer to where (`WorkerSession` around the background-command handling) would save the next reader a search.",
  },
];

const concerns = [
  {
    severity: "question",
    title: "The transcript path copies Claude Code's naming",
    detail: "Resume correctness now depends on an undocumented folder layout. See c1.",
    target: drafts[0],
  },
  {
    severity: "suggestion",
    title: "Permission errors count as never saved",
    detail: "A narrow edge, but it silently forks a conversation. See c2.",
    target: drafts[1],
  },
];

const readingOrder = [
  ["src/harness/claude-code/launch.ts", "The resume fix: `chooseConversation` now knows if the conversation was saved."],
  ["src/harness/claude-code/plugins/tandem/hooks/protocol.ts", "`interactive` becomes `origin`, which the worker fix needs."],
  ["src/harness/claude-code/worker.ts", "Drops a task notification that arrives after the report."],
  ["src/session/notifications.ts", "Moves the follow-up directions into the wake's hidden part."],
];

const diagram = `flowchart TB
  subgraph resume["Resume a never-saved conversation"]
    direction LR
    CL["coordinator/launch.ts<br/>passes cwd"]:::touched --> CCL["claude-code/launch.ts<br/>chooseConversation"]:::changed
    WJ["worker.ts<br/>passes cwd"]:::touched --> CCL
    IO["launch-io.ts<br/>exists()"]:::changed --> CCL
  end
  subgraph wake["Drop the post-report wake"]
    direction LR
    PR["hooks/protocol.ts<br/>origin"]:::changed --> TR["hooks/translate.ts"]:::touched --> CW["claude-code/worker.ts<br/>handled: true"]:::changed --> SW["session/worker.ts<br/>reportSubmitted"]:::touched
  end
  subgraph hide["Hide follow-up directions"]
    direction LR
    NO["session/notifications.ts"]:::changed --> RF["research-follow-up.ts"]:::touched
  end
  hide ~~~ wake ~~~ resume
  classDef changed fill:#3b2f22,stroke:#f4c08a,color:#ecebf3
  classDef touched fill:#23232e,stroke:#363644,color:#a3a2b3
  click CL call jump("src/coordinator/launch.ts")
  click CCL call jump("src/harness/claude-code/launch.ts")
  click WJ call jump("src/worker.ts")
  click IO call jump("src/harness/launch-io.ts")
  click PR call jump("src/harness/claude-code/plugins/tandem/hooks/protocol.ts")
  click TR call jump("src/harness/claude-code/plugins/tandem/hooks/translate.ts")
  click CW call jump("src/harness/claude-code/worker.ts")
  click SW call jump("src/session/worker.ts")
  click NO call jump("src/session/notifications.ts")
  click RF call jump("src/session/research-follow-up.ts")`;
import { createCssVariablesTheme, createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
const REPO = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"]).stdout.toString().trim();
const HEAD = "9b0411b42ae4c6690bbd757e23a8619847fe52a1";
const tandemCss = await Bun.file(`${REPO}/src/pages/tandem.css`).text();
const sources: Record<string, string[]> = {};
for (const f of files) {
  const out = Bun.spawnSync(["git", "-C", REPO, "show", `${HEAD}:${f.path}`]);
  if (out.exitCode === 0) sources[f.path] = out.stdout.toString().replace(/\n$/, "").split("\n");
}


function findLine(path: string, needle: string, after = 0): number {
  const lines = sources[path] ?? [];
  const i = lines.findIndex((l, n) => n + 1 > after && l.includes(needle));
  if (i < 0) throw new Error(`tour: no "${needle}" in ${path}`);
  return i + 1;
}
type Step = { chapter: number; file: string; from: number; to: number; title: string; body: string; draft?: string };
const chapters = [
  { title: "Hide follow-up directions", why: "The person stops seeing directions meant for the model.", node: "NO" },
  { title: "Drop the post-report wake", why: "A late background task no longer starts a turn after the report.", node: "PR" },
  { title: "Resume a never-saved conversation", why: "Resuming a coordinator quit before its first message starts fresh instead of failing.", node: "CL" },
];
const stepAt = (chapter: number, file: string, fromNeedle: string, toNeedle: string, title: string, body: string, draft?: string): Step => {
  const from = findLine(file, fromNeedle);
  return { chapter, file, from, to: findLine(file, toNeedle, from - 1), title, body, ...(draft ? { draft } : {}) };
};
const N = "src/session/notifications.ts";
const P = "src/harness/claude-code/plugins/tandem/hooks/protocol.ts";
const TR = "src/harness/claude-code/plugins/tandem/hooks/translate.ts";
const CW = "src/harness/claude-code/worker.ts";
const SW = "src/session/worker.ts";
const CL = "src/coordinator/launch.ts";
const CCL = "src/harness/claude-code/launch.ts";
const IO = "src/harness/launch-io.ts";
const tour: Step[] = [
  stepAt(0, N, "Judgment-needed notifications shown to the user", "function judgmentDisplayContent", "What the person sees loses the directions", "`judgmentDisplayContent` builds the text shown in the pane. It no longer appends `followUp`, the \"Give the user a summary…\" directions. The removed line sits just below this function."),
  stepAt(0, N, "const followUps", "...followUps,", "The directions move to the hidden part", "`judgmentIdentifiers` is the half of the wake the host never renders. The follow-up directions now ride here, so the model still gets them on both harnesses."),
  stepAt(1, P, "Where a prompt came from", "export type PromptOrigin", "A prompt now says where it came from", "The wire protocol replaces the `interactive` flag with `origin`: the person's Enter (`composer`), a finished background task (`task-notification`), or anything else."),
  stepAt(1, TR, "function promptOrigin(kind", "origin: promptOrigin(prompt.origin.kind)", "The mod fills in the origin", "The Claude Code mod maps Claude Code's `PromptOrigin.kind` onto the three values. Anything unknown becomes `other`, never `composer`."),
  stepAt(1, CW, 'event.origin === "composer"', 'return { type: "promptRoute", handled: true }', "The worker drops the late wake", "A task notification that arrives after the report answers `handled: true`, which tells the mod to drop the prompt. Before this, it started a turn for nothing.", "c3"),
  stepAt(1, SW, "get reportSubmitted()", "return this.resultPublished", "How the worker knows the report is in", "`reportSubmitted` exposes the session's existing `resultPublished` flag. No new state."),
  stepAt(2, CL, "const conversation = await harness.conversation(", "cwd: coordinatorCwd", "Launch passes the working directory", "Claude Code files a conversation under the folder it ran in, so the coordinator launch now passes `cwd`. The worker launch in `src/worker.ts` does the same."),
  stepAt(2, CCL, "const recorded =", "io.exists(claudeTranscriptPath(cwd, id))", "Check whether the conversation was ever saved", "Before resuming, Tandem checks for the transcript file. Claude Code writes nothing until the first prompt, so a coordinator quit before typing has none."),
  stepAt(2, CCL, "export function claudeTranscriptPath(", 'join(configDirectory, "projects"', "Where that file lives", "The path copies Claude Code's folder naming: every character outside `[A-Za-z0-9]` becomes `-`. Tandem flags this as the main risk.", "c1"),
  stepAt(2, CCL, "export function chooseConversation(", ": { id: newId(), resume: false }", "Never saved means start fresh, same id", "A recorded but unsaved conversation runs with `--session-id` instead of `--resume`, keeping the recorded id true. This is the actual fix for the 30-second trust error."),
  stepAt(2, IO, "exists:", "() => false,", "The file check itself", "`exists` treats any `access` error as missing. Tandem suggests counting only ENOENT, as `isMissing` above already does.", "c2"),
];

// ponytail: invented example, to show where a concern with no line goes
const overall = [{ severity: "question", title: "No test covers a refused --session-id", detail: "If the transcript naming drifts, the launch fails. Nothing exercises that path." }];
const nodes = [...diagram.matchAll(/click (\w+) call jump\("([^"]+)"\)/g)].map((m) => ({ id: m[1]!, file: m[2]! }));
const walkDiagram = diagram.replace(/click (\w+) call jump\("[^"]+"\)/g, 'click $1 call pick("$1")');
const BASE = Bun.spawnSync(["git", "-C", REPO, "merge-base", "66c7ac940c2b43cec47718de5c771a6819391f70", HEAD]).stdout.toString().trim();
const oldSources: Record<string, string[]> = {};
for (const f of files) {
  const out = Bun.spawnSync(["git", "-C", REPO, "show", `${BASE}:${f.path}`]);
  if (out.exitCode === 0) oldSources[f.path] = out.stdout.toString().replace(/\n$/, "").split("\n");
}
const highlighter = await createHighlighter({
  themes: [createCssVariablesTheme({ name: "tandem", variablePrefix: "--shiki-", fontStyle: true })],
  langs: ["typescript", "markdown"],
  engine: createJavaScriptRegexEngine(),
});
const langFor = (path: string) => (path.endsWith(".md") ? "markdown" : "typescript");
const escText = (t: string) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// ponytail: one-letter classes keep embedded files small; extend the map if a grammar emits a new token kind
const TOKEN_CLASS: Record<string, string> = { keyword: "k", function: "f", string: "s", "string-expression": "s", constant: "c", parameter: "p", comment: "m", punctuation: "u", link: "l", inserted: "s", deleted: "d", changed: "p" };
function highlight(path: string, lines: string[] | undefined): string[] | undefined {
  if (!lines) return undefined;
  const { tokens } = highlighter.codeToTokens(lines.join("\n"), { lang: langFor(path), theme: "tandem" });
  return tokens.map((line) =>
    line
      .map((t) => {
        const kind = /--shiki-token-([a-z-]+)/.exec(t.color ?? "")?.[1];
        const cls = kind ? TOKEN_CLASS[kind] : undefined;
        return cls ? `<i class="${cls}">${escText(t.content)}</i>` : escText(t.content);
      })
      .join(""),
  );
}
const newHtml: Record<string, string[]> = {};
const oldHtml: Record<string, string[]> = {};
for (const f of files) {
  const n = highlight(f.path, sources[f.path]); if (n) newHtml[f.path] = n;
  const o = highlight(f.path, oldSources[f.path]); if (o) oldHtml[f.path] = o;
}
const codeHtml = (path: string, r: Row) =>
  (r.kind === "del" ? oldHtml[path]?.[r.old! - 1] : newHtml[path]?.[r.new! - 1]) ?? esc(r.text);
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const base = (p: string) => p.split("/").pop()!;
const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
const sevOrder = ["blocking", "question", "suggestion", "nit"];
const embedJson = (v: unknown) =>
  JSON.stringify(v).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");

const CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;
const EXPAND = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>`;

function draftCard(d: Draft, inline: boolean): string {
  const where = `<button class="loc" data-file="${esc(d.file)}" data-line="${d.line}">${esc(base(d.file))}:${d.line}</button>`;
  return `<article class="draft ${inline ? "inline" : "side"}" data-draft="${d.id}" data-state="pending" data-body="${esc(d.body)}">
<header><span class="by"><i class="mark">T</i>Tandem</span><span class="sev" data-sev="${d.severity}">${d.severity}</span>${inline ? "" : where}<span class="state"></span></header>
<p>${md(d.body)}</p>
<footer><button class="link approve" data-act="approve">Add to review</button><button class="link" data-act="skip">Dismiss</button><button class="link" data-act="edit">Edit</button></footer>
</article>`;
}

const COLLAPSE_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l3 3 3-3M5 13l3-3 3 3"/></svg>`;
const EXPAND_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>`;
type Gap = { from: number; to: number; delta: number; dir: "up" | "down"; label: string };
// ponytail: only the lines nearest each change are embedded; past this budget the row links to GitHub
const EXPAND_BUDGET = 40;
const nearHtml: Record<string, Record<number, string>> = {};
let gapFile = "";

function gapRow(g: Gap): string {
  const n = g.to - g.from + 1;
  if (n <= 0) return "";
  const budget = Math.min(n, EXPAND_BUDGET);
  const [a, b] = g.dir === "up" ? [g.to - budget + 1, g.to] : [g.from, g.from + budget - 1];
  const lines = (nearHtml[gapFile] ??= {});
  for (let i = a; i <= b; i++) lines[i] = newHtml[gapFile]?.[i - 1] ?? "";
  return `<tr class="gap" data-from="${g.from}" data-to="${g.to}" data-delta="${g.delta}" data-dir="${g.dir}" data-budget="${budget}"><td colspan="2" class="gap-btn"><button class="exp" data-expand="20" title="Show 20 more lines">${EXPAND}</button></td><td class="gap-label"><button class="exp-all" data-expand="all"><span class="n">${n}</span> <span class="w">hidden line${n === 1 ? "" : "s"}</span></button>${g.label ? `<span class="ctx">${esc(g.label)}</span>` : ""}</td></tr>`;
}

function renderFile(f: FileDiff): string {
  gapFile = f.path;
  const lines = sources[f.path];
  let out = "";
  let prevNewEnd = 0;
  let prevDelta = 0;
  for (const r of f.rows) {
    if (r.kind === "hunk") {
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)/.exec(r.text)!;
      const oldStart = Number(m[1]);
      const newStart = Number(m[3]);
      out += gapRow({ from: prevNewEnd + 1, to: newStart - 1, delta: oldStart - newStart, dir: "up", label: m[5] ?? "" });
      prevDelta = oldStart + Number(m[2] ?? 1) - (newStart + Number(m[4] ?? 1));
      continue;
    }
    if (r.new !== undefined) prevNewEnd = r.new;
    const id = r.new !== undefined && r.kind !== "del" ? ` id="${lineId(f.path, r.new)}"` : "";
    out += `<tr class="${r.kind}"${id} data-line="${r.kind === "del" ? "" : (r.new ?? "")}"><td class="no">${r.old ?? ""}</td><td class="no hook"${r.kind === "del" ? "" : " data-lavish-action"}>${r.new ?? ""}</td><td class="code">${codeHtml(f.path, r) || " "}</td></tr>`;
    for (const d of drafts.filter((d) => d.file === f.path && d.line === r.new && r.kind !== "del")) {
      out += `<tr class="note"><td colspan="3">${draftCard(d, true)}</td></tr>`;
    }
  }
  if (lines) out += gapRow({ from: prevNewEnd + 1, to: lines.length, delta: prevDelta, dir: "down", label: "" });
  const n = drafts.filter((d) => d.file === f.path).length;
  return `<section class="file panel" id="${fileId(f.path)}" data-path="${esc(f.path)}" data-expanded="true">
<div class="file-head"><button class="fold" aria-expanded="true" title="Collapse file">${CHEVRON}</button><button class="path" data-fold><span class="dir">${esc(dirOf(f.path))}/</span>${esc(base(f.path))}</button>${n ? `<span class="tag">${n} draft${n > 1 ? "s" : ""}</span>` : ""}<span class="stat num"><span class="plus">+${f.adds}</span> <span class="minus">−${f.dels}</span></span>
<label class="viewed"><input type="checkbox" data-viewed="${esc(f.path)}"> Viewed</label></div>
<div class="drawer"><div><table class="diff"><colgroup><col class="c-no"><col class="c-no"><col></colgroup><tbody>${out}</tbody></table></div></div></section>`;
}

const groups = new Map<string, FileDiff[]>();
for (const f of files) groups.set(dirOf(f.path), [...(groups.get(dirOf(f.path)) ?? []), f]);
const tree = [...groups]
  .map(
    ([dir, fs]) =>
      `<div class="dir" data-collapsed="false"><button class="dir-label" title="${esc(dir)}"><span class="chev">${CHEVRON}</span><span class="dname">${esc(dir)}</span>${fs.some((f) => drafts.some((d) => d.file === f.path)) ? '<span class="dot"></span>' : ""}<span class="dcount num">${fs.length}</span></button><div class="dir-files"><div>${fs
        .map((f) => {
          const n = drafts.filter((d) => d.file === f.path).length;
          return `<button class="res tree-file" data-open="${esc(f.path)}"><span class="tick"></span><b>${esc(base(f.path))}</b>${n ? `<span class="dot" title="${n} draft"></span>` : ""}<span class="stat num"><span class="plus">+${f.adds}</span> <span class="minus">−${f.dels}</span></span></button>`;
        })
        .join("")}</div></div></div>`,
  )
  .join("");

const totalAdds = files.reduce((n, f) => n + f.adds, 0);
const totalDels = files.reduce((n, f) => n + f.dels, 0);
const sortedDrafts = [...drafts].sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));

const filesHtml = files.map(renderFile).join("\n");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review #266</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${tandemCss}

body{padding:0;height:100vh;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}
.mast{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--faint);min-width:0}
.mast h1{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mast .who{white-space:nowrap}.mast .who b{color:var(--muted);font-weight:500}
.mast a{color:var(--muted)}
.mast h1{flex:1;min-width:0}
.to-top{cursor:pointer}.to-top:hover{color:var(--you)}
.mast-actions{flex:none;display:flex;align-items:center;gap:8px}
.mast .gh{padding:7px 9px}
.meta-line{margin:0 0 10px;font-size:12.5px;color:var(--faint)}.meta-line b{color:var(--muted);font-weight:500}.meta-line a{color:var(--muted)}
.plus{color:var(--done)}.minus{color:var(--tandem)}
.stat{font-size:11.5px;white-space:nowrap}

.shell{--rail:250px;display:grid;grid-template-columns:var(--rail) minmax(0,1fr) 330px;min-height:0;transition:grid-template-columns .3s var(--ease)}
body.rail-hidden .shell{--rail:44px}
.rail-open{display:none}
body.rail-hidden .rail>*:not(.rail-open){display:none}
body.rail-hidden .rail{padding:12px 6px;overflow:hidden}
body.rail-hidden .rail-open{all:unset;cursor:pointer;display:grid;place-items:center;width:30px;height:30px;border-radius:var(--rc);color:var(--muted)}
body.rail-hidden .rail-open:hover{background:var(--line);color:var(--ink)}
.rail,.review-pane,.mainpane{overflow:auto;min-height:0}
.rail{border-right:1px solid var(--line);padding:14px 10px 32px}
.review-pane{border-left:1px solid var(--line);padding:18px 16px 0;display:flex;flex-direction:column}
.mainpane{padding:18px 24px 64px}
.review-toggle{display:none}
@media (max-width:1100px){
.shell{--rail:210px;grid-template-columns:var(--rail) minmax(0,1fr)}
body.rail-hidden .shell{--rail:44px}
.review-toggle{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;white-space:nowrap}
.review-pane{position:fixed;top:0;right:0;bottom:0;width:min(360px,92vw);z-index:40;background:var(--bg);box-shadow:-16px 0 40px rgb(0 0 0 / .5);transform:translateX(100%);transition:transform .3s var(--ease)}
body.review-open .review-pane{transform:none}
}
.side-close{display:none}
@media (max-width:1100px){.side-close{display:inline-flex}}
@media (max-width:760px){.shell{grid-template-columns:minmax(0,1fr)}.rail{display:none}.mast .who:not(:last-of-type){display:none}}

.rail-head{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--faint);padding:0 8px 6px}
.dir-label{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;gap:6px;cursor:pointer;font:11px var(--mono);color:var(--faint);padding:8px 8px 3px 2px;border-radius:var(--rc)}
.dir-label:hover{color:var(--muted)}
.dname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dcount{margin-left:auto;font-size:10.5px;opacity:0;transition:opacity .2s}
.dir[data-collapsed="true"] .dcount{opacity:1}
.chev{display:grid;place-items:center;transition:transform .25s var(--ease)}
.chev svg{width:12px;height:12px}
.dir[data-collapsed="true"] .chev{transform:rotate(-90deg)}
.dir-label .dot{display:none}
.dir[data-collapsed="true"] .dir-label .dot{display:block}
.dir-files{display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s var(--ease)}
.dir-files>div{overflow:hidden;min-height:0}
.dir[data-collapsed="true"] .dir-files{grid-template-rows:0fr}
.rail-tools{display:flex;gap:4px}
.rail-tools{display:flex;gap:2px}.rail-tools button{all:unset;cursor:pointer;display:grid;place-items:center;width:24px;height:24px;color:var(--faint);border-radius:var(--rb)}
.rail-tools button:hover{color:var(--ink);background:var(--line)}
.tree-file{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--rc);cursor:pointer}
.tree-file:hover,.tree-file.on{background:var(--sunk)}
.tree-file b{font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree-file .stat{margin-left:auto}
.tick{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--line2);flex:none;transition:background .2s,border-color .2s}
.tree-file.viewed .tick{background:var(--done);border-color:var(--done)}
.tree-file.viewed b{color:var(--faint)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--you);flex:none}

.tabs{margin-bottom:18px}
.view{gap:28px}
.lead{margin:0;font-size:15.5px;line-height:1.6;max-width:72ch}
.verdict{display:inline-flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--muted)}
.verdict i{width:7px;height:7px;border-radius:50%;background:var(--done)}
.h{display:flex;align-items:baseline;gap:10px;margin:0 0 10px;font-size:13px;font-weight:600}
.h span{font:11.5px var(--mono);color:var(--faint);font-weight:400}
.list{overflow:hidden}
.crow{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:2px 16px;align-items:baseline;padding:12px 14px;border-top:1px solid var(--line)}
.crow:first-child{border-top:0}
.crow strong{font-weight:500}
.crow p{grid-column:2/4;margin:0;color:var(--muted);font-size:13px}
.sev{font:500 11px/1 var(--mono);padding:3px 6px;border-radius:var(--rb);justify-self:start;--c:var(--muted);background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c)}
.sev[data-sev="blocking"]{--c:var(--tandem)}.sev[data-sev="question"]{--c:var(--implement)}.sev[data-sev="suggestion"]{--c:var(--done)}.sev[data-sev="nit"]{--c:var(--faint)}.sev[data-sev="you"]{--c:var(--you)}
.loc{all:unset;cursor:pointer;font:12px var(--mono);color:var(--muted);white-space:nowrap;border-bottom:1px dotted var(--line2)}
.loc:hover{color:var(--ink);border-color:var(--muted)}
.diagram{padding:14px}
.diagram-out{text-align:center}.diagram-out svg{display:inline-block;max-width:100%;height:auto}.diagram .node{cursor:pointer}
.hint{margin:8px 0 0;font-size:12px;color:var(--faint)}
.steps{list-style:none;margin:0;padding:0;counter-reset:s}
.steps li{counter-increment:s;display:grid;grid-template-columns:22px minmax(0,1fr);gap:2px 12px;padding:10px 14px;border-top:1px solid var(--line)}
.steps li:first-child{border-top:0}
.steps li::before{content:counter(s);grid-row:1/3;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--sunk);font:500 11px var(--mono);color:var(--muted)}
.steps .loc{justify-self:start}
.steps small{color:var(--muted);font-size:12.5px}
.start{justify-self:start;margin-top:12px}

.changes,.view{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}
.file{overflow:clip}
.file-head{position:sticky;top:-18px;z-index:2;display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--raise);border-bottom:1px solid var(--line);border-radius:10px 10px 0 0}
.file[data-expanded="false"] .file-head{border-bottom-color:transparent;border-radius:10px}
.fold{all:unset;cursor:pointer;display:grid;place-items:center;width:22px;height:22px;border-radius:var(--rc);color:var(--muted);transition:transform .25s var(--ease),background .2s}
.fold:hover{background:var(--line)}
.file[data-expanded="false"] .fold{transform:rotate(-90deg)}
.path{all:unset;cursor:pointer;font:500 13px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.path .dir{color:var(--faint);font-weight:400}
.file-head .stat{margin-left:auto}
.viewed{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);cursor:pointer;white-space:nowrap;padding:3px 8px;border-radius:var(--rc);background:var(--sunk)}
.drawer{display:grid;grid-template-rows:1fr;transition:grid-template-rows .35s var(--ease)}
.drawer>div{overflow:hidden;min-height:0}
.file[data-expanded="false"] .drawer{grid-template-rows:0fr}

td.code i{font-style:normal}td.code .k{color:var(--review)}td.code .f{color:var(--research)}td.code .s{color:var(--done)}td.code .c{color:var(--implement)}td.code .p{color:var(--you)}td.code .m{color:var(--faint);font-style:italic}td.code .u{color:var(--muted)}td.code .l{color:var(--implement)}td.code .d{color:var(--tandem)}
table.diff{width:100%;border-collapse:collapse;table-layout:fixed;font:12.5px/1.65 var(--mono)}
table.diff td{border:0;padding:0;color:var(--ink)}
col.c-no{width:46px}
td.no{text-align:right;padding:0 8px!important;color:var(--faint)!important;user-select:none;vertical-align:top}
td.code{white-space:pre-wrap;word-break:break-word;padding:0 16px 0 12px!important}
tr.add td{background:color-mix(in srgb,var(--done) 9%,transparent)}
tr.add td.no{background:color-mix(in srgb,var(--done) 16%,transparent);color:var(--done)!important}
tr.del td{background:color-mix(in srgb,var(--tandem) 9%,transparent)}
tr.del td.no{background:color-mix(in srgb,var(--tandem) 16%,transparent);color:var(--tandem)!important}
tr.ctx.revealed td{animation:rowIn .3s var(--ease) both}
tr.gap td{background:var(--sunk);color:var(--faint)!important;font-size:11.5px}
.gap-btn{text-align:right}
.exp,.exp-all{all:unset;cursor:pointer;color:var(--muted)}
.exp{display:inline-grid;place-items:center;width:28px;height:22px;border-radius:var(--rb);margin-right:6px;vertical-align:middle}
.exp:hover{background:var(--line2);color:var(--ink)}
.gap-label{padding:3px 12px!important}
.exp-all:hover{color:var(--ink)}
.exp-all .n{font-family:var(--mono)}
.ctx{margin-left:12px;color:var(--faint)}
tr[data-line]:not([data-line=""]) td.hook{cursor:pointer;position:relative}
tr[data-line]:not([data-line=""]):hover td.hook::after{content:"+";position:absolute;right:-10px;top:2px;width:18px;height:18px;line-height:18px;text-align:center;border-radius:var(--rb);background:var(--you);color:var(--bg);font-weight:700;z-index:1}
tr.flash td{animation:flash 1.8s var(--ease)}
@keyframes flash{from{background:color-mix(in srgb,var(--you) 30%,transparent)}}
tr.note td{padding:10px 16px 12px 104px!important;background:var(--bg)}

.draft{font:13px/1.55 var(--sans);background:var(--sunk);border:1px solid var(--line);border-radius:10px;padding:10px 12px;transition:border-color .2s,opacity .2s}
.draft.inline{max-width:680px;background:var(--raise)}
.draft header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.by{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-weight:500}
.mark{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:color-mix(in srgb,var(--tandem) 22%,transparent);color:var(--tandem);font:600 9.5px var(--sans);font-style:normal}
.mark.me{background:color-mix(in srgb,var(--you) 22%,transparent);color:var(--you)}
.draft .state{margin-left:auto;font-size:11.5px;color:var(--faint)}
.draft p{margin:6px 0 8px}
.draft.side p{color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.draft footer{display:flex;gap:6px}
.draft[data-state="approved"]{border-color:color-mix(in srgb,var(--done) 45%,var(--line))}
.draft[data-state="approved"] .approve{background:color-mix(in srgb,var(--done) 22%,transparent);color:var(--done)}
.draft[data-state="approved"] .state{color:var(--done)}
.draft[data-state="skipped"]{opacity:.45}
.draft textarea{width:100%;min-height:70px;font:inherit;color:var(--ink);background:var(--sunk);border:1px solid var(--line2);border-radius:var(--rc);padding:7px 9px;margin:6px 0 8px;resize:vertical}

.review-pane h2{margin:0;font-size:15px;font-weight:600}
.review-pane .sec-note{margin:4px 0 16px;font-size:12.5px}
.review-pane h3{margin:16px 0 8px;font-size:11.5px;font-weight:500;color:var(--faint);display:flex;justify-content:space-between}
.stack{display:grid;gap:8px}
.review-pane>*{flex-shrink:0}
.summary{padding:10px 12px;font-size:13px}
.summary p{margin:0}
.post{position:sticky;bottom:0;margin-top:auto;padding:14px 0 16px;background:var(--bg);display:grid;gap:10px;border-top:1px solid var(--line)}
.verdict-pick{display:flex;gap:4px;background:var(--sunk);border-radius:var(--rp);padding:3px}
.verdict-pick label{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;font-size:12.5px;color:var(--muted);padding:6px 4px;border-radius:var(--rc);cursor:pointer;white-space:nowrap}
.verdict-pick input{position:absolute;opacity:0;pointer-events:none}
.verdict-pick label:has(input:checked){background:var(--line2);color:var(--ink)}
.verdict-pick label:has(input[value=approve]:checked){color:var(--done)}
.verdict-pick label:has(input[value=request-changes]:checked){color:var(--tandem)}
.post-row{display:flex;gap:8px}.post-row .primary{flex:1}.post-row .link{padding:8px 12px}
.post-status{margin:0;font-size:12.5px;color:var(--muted)}
.post-status b{color:var(--ink);font-weight:500}
.finish-btn{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;white-space:nowrap}
.finish-btn .badge{background:color-mix(in srgb,var(--bg) 25%,transparent);border-radius:999px;padding:0 7px;font-size:11.5px}
.finish-btn.sent{background:color-mix(in srgb,var(--done) 22%,transparent);color:var(--done)}
.draft .state:not(:empty){font:500 11px/1 var(--mono);padding:3px 6px;border-radius:var(--rb);background:color-mix(in srgb,var(--you) 16%,transparent);color:var(--you)}
.draft[data-state="skipped"] .state{background:var(--line)!important;color:var(--faint)!important}
.finish{max-width:560px}
.finish h2{margin:0 0 14px;font-size:16px}
.f-label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
.f-label small{font-weight:400;color:var(--faint);margin-left:6px}
.finish textarea{width:100%;font:13px/1.5 var(--sans);color:var(--ink);background:var(--sunk);border:1px solid var(--line2);border-radius:var(--rc);padding:8px 10px;resize:vertical}
.f-verdicts{border:0;margin:14px 0 0;padding:0;display:grid;gap:4px}
.f-verdicts label{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:var(--rc);cursor:pointer}
.f-verdicts label:hover{background:var(--sunk)}
.f-verdicts label:has(input:checked){background:var(--sunk)}
.f-verdicts input{margin-top:3px}
.f-verdicts b{display:block;font-weight:500;font-size:13.5px}
.f-verdicts small{color:var(--muted);font-size:12.5px}
.f-verdicts label:has(input[value=approve]:checked) b{color:var(--done)}
.f-verdicts label:has(input[value=request-changes]:checked) b{color:var(--tandem)}
.f-summary-line{margin:14px 0 0;font-size:12.5px;color:var(--muted)}
.f-summary-line b{color:var(--ink);font-weight:500}
.f-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.payload{white-space:pre-wrap;font:12px var(--mono);color:var(--muted);max-height:50vh;overflow:auto}
.post-note{margin:0;font-size:11.5px;color:var(--faint);text-align:center}
.post-note.sent{color:var(--done)}
.spacer-y{height:16px}


.gh{display:inline-flex;align-items:center;gap:7px;text-decoration:none;padding:6px 12px;white-space:nowrap}
.view{gap:0}
.sec{padding:26px 0;border-top:1px solid var(--line);display:grid;gap:14px}
.sec:first-child{border-top:0;padding-top:4px}
.sec-h{display:flex;align-items:flex-start;gap:12px}
.sec-h>div{flex:1}
.sec-h h2{margin:0;font-size:15px;font-weight:600}
.sec-h .sec-note{margin-top:2px;font-size:12.5px}
.sec-n{font-size:11px;color:var(--faint);padding-top:3px;width:18px}
.take{margin:12px 0 0;color:var(--muted);font-size:13.5px}.take b{color:var(--ink);font-weight:600}
.orow{display:grid;gap:4px;padding:10px 12px;font-size:13px}.orow b{font-weight:500}.orow p{margin:0;color:var(--muted);font-size:12.5px}
.facts{display:flex;flex-wrap:wrap;gap:8px}
.fact{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);background:var(--raise);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.fact i{width:7px;height:7px;border-radius:50%;background:var(--c)}
.chapters{display:grid;gap:10px}
.chapter{padding:6px}
.ch-h{display:flex;gap:12px;align-items:flex-start;padding:8px 8px 6px}
.ch-h b{display:block;font-weight:500}
.ch-h small{color:var(--muted);font-size:12.5px}
.ch-n{display:grid;place-items:center;width:22px;height:22px;border-radius:var(--rc);background:color-mix(in srgb,var(--you) 16%,transparent);color:var(--you);font-size:11.5px;flex:none}
.stops{list-style:none;margin:0;padding:0}
.stop{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;gap:12px;padding:7px 8px 7px 42px;border-radius:var(--rc);cursor:pointer;font-size:13px}
.stop:hover{background:var(--sunk)}
.stop-n{font-size:11px;color:var(--faint);width:16px;text-align:right}
.stop-t{flex:1;min-width:0}
.stop-f{font-size:11.5px;color:var(--faint);white-space:nowrap}

.tour{position:sticky;bottom:0;margin-top:16px;z-index:5;background:var(--raise);border:1px solid var(--line2);border-radius:12px;padding:12px 16px;box-shadow:0 -12px 32px rgb(0 0 0 / .35);animation:rowIn .35s var(--ease) both}
.tour-top{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--faint)}
.tour-ch{color:var(--you);font-weight:500;white-space:nowrap}
.trail{display:flex;align-items:center;gap:2px;margin-top:6px;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
.trail .ln{color:var(--faint)}
.trail button.now .ln{color:inherit;opacity:.7}
.trail button{all:unset;cursor:pointer;font:11.5px var(--mono);color:var(--faint);padding:2px 6px;border-radius:var(--rb)}
.trail button:hover{color:var(--ink)}
.trail button.now{background:color-mix(in srgb,var(--you) 16%,transparent);color:var(--you)}
.trail button.done{color:var(--muted)}
.trail .arrow{color:var(--line2)}
.x{all:unset;cursor:pointer;margin-left:auto;color:var(--faint);padding:2px 6px;border-radius:var(--rb)}
.x:hover{color:var(--ink);background:var(--line)}
.tour h3{margin:10px 0 2px;font-size:14.5px;font-weight:600}
.tour p{margin:0;color:var(--muted);max-width:76ch}
#tour-draft:not(:empty){margin-top:8px}
.has-draft{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.tour-nav{display:flex;align-items:center;gap:12px;margin-top:10px}
.tour-nav .num{font-size:12px;color:var(--faint)}
.pips{display:flex;gap:4px;flex:1}
.pips i{width:6px;height:6px;border-radius:50%;background:var(--line2)}
.pips i.on{background:var(--you)}
.pips i.seen{background:var(--muted)}
.file.touring tr:not(.spot):not(.note):not(.gap) td{opacity:.4;transition:opacity .3s}
tr.spot td{background:color-mix(in srgb,var(--you) 11%,transparent)}
tr.spot td.no{color:var(--you)!important}
tr.spot.add td{background:color-mix(in srgb,var(--you) 9%,color-mix(in srgb,var(--done) 9%,transparent))}

.detail{padding:6px}
.ch-row{display:flex;align-items:center;gap:12px;padding:10px 10px;border-top:1px solid var(--line)}
.ch-row:first-child{border-top:0}
.ch-row>div{flex:1;min-width:0}
.ch-row b{display:block;font-weight:500}
.ch-row small{color:var(--muted);font-size:12.5px}
.ch-row .count{font:11.5px var(--mono);color:var(--faint);white-space:nowrap}
.node-h{display:flex;align-items:flex-start;gap:12px;padding:10px 10px 4px}
.node-h>div{flex:1;min-width:0}
.node-h .path{font:500 13px var(--mono)}
.node-h small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.back{all:unset;cursor:pointer;font-size:12px;color:var(--faint);padding:2px 6px;border-radius:var(--rb)}
.back:hover{color:var(--ink);background:var(--line)}
.nstop{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:2px 12px;align-items:baseline;padding:10px;border-top:1px solid var(--line)}
.nstop .stop-n{font-size:11px;color:var(--faint);text-align:right}
.nstop b{font-weight:500}
.nstop p{grid-column:2/4;margin:0;color:var(--muted);font-size:13px}
.nstop .stop-f{font:11.5px var(--mono);color:var(--faint);white-space:nowrap}
.nstop .acts{grid-column:2/4;display:flex;gap:6px;margin-top:6px}
.none{padding:10px;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}
#diagram-out .node.picked rect{stroke:var(--you)!important;stroke-width:2px!important}
#diagram-out .node.dim{opacity:.45}

.diagram{position:relative}
.pop{position:absolute;z-index:6;background:var(--raise);border:1px solid var(--line2);border-radius:12px;padding:12px 14px;box-shadow:0 16px 40px rgb(0 0 0 / .45);text-align:left;animation:popIn .2s var(--ease) both}
@keyframes popIn{from{opacity:0;transform:translateY(4px) scale(.98)}}
.pop::before{content:"";position:absolute;top:-6px;left:calc(var(--caret,50%) - 6px);width:10px;height:10px;background:var(--raise);border-left:1px solid var(--line2);border-top:1px solid var(--line2);transform:rotate(45deg)}
.pop-h{display:flex;align-items:flex-start;gap:10px}
.pop-h>div{flex:1;min-width:0}
.pop-h .path{font:500 12.5px var(--mono);word-break:break-all}
.pop-h small{display:block;color:var(--you);font-size:12px;margin-top:2px}
.pstop{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;padding:9px 0 0;margin-top:9px;border-top:1px solid var(--line)}
.pstop .stop-n{font-size:11px;color:var(--faint);text-align:right;padding-top:2px}
.pstop b{font-weight:500;font-size:13px}
.pstop p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.pnone{margin:8px 0 0;color:var(--muted);font-size:12.5px}
.pop-acts{display:flex;gap:8px;margin-top:12px}
dialog{border:1px solid var(--line2);border-radius:12px;background:var(--raise);color:var(--ink);max-width:540px;width:calc(100% - 32px);padding:20px}
dialog::backdrop{background:rgb(0 0 0 / .55)}
dialog h2{margin:0 0 10px;font-size:16px}dialog li{margin:0 0 6px;color:var(--muted)}dialog li b{color:var(--ink);font-weight:500}
kbd{font:11px var(--mono);border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;padding:0 4px;color:var(--muted)}
</style>
</head>
<body>
<header class="mast">
<span class="tag">#266</span>
<h1 class="to-top" data-lavish-action role="button" tabindex="0" title="Back to top: fix(harness): Claude Code rough edges: hidden follow-up, dropped post-report wake, never-saved resume">fix(harness): Claude Code rough edges: hidden follow-up, dropped post-report wake, never-saved resume</h1>
<div class="mast-actions">
<button class="link review-toggle" id="review-toggle">Suggestions <span class="num" id="review-count"></span></button>
<button class="primary finish-btn" id="finish-open">Review changes <span class="badge num" id="finish-count">0</span></button>
<a class="link gh" data-lavish-action href="https://github.com/jdeocampo99/tandem/pull/266" target="_blank" rel="noopener" title="View on GitHub" aria-label="View on GitHub"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
</div>
</header>

<div class="shell">
<nav class="rail">
<button class="rail-open" id="rail-open" title="Show file list" aria-label="Show file list"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg></button>
<div class="rail-head"><span class="num" style="white-space:nowrap"><b id="viewed-count">0</b>/${files.length} viewed</span><span class="rail-tools"><button id="dirs-toggle" title="Collapse all folders" aria-label="Collapse all folders"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l3 3 3-3M5 13l3-3 3 3"/></svg></button><button id="rail-toggle" title="Hide file list" aria-label="Hide file list"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg></button></span></div>
${tree}
</nav>

<main class="mainpane" id="main">
<div class="tabs" id="tabs" role="tablist"><span class="tab-ind" aria-hidden="true"></span>
<button class="tab" role="tab" aria-selected="true" data-tab="overview">Overview</button>
<button class="tab" role="tab" aria-selected="false" data-tab="changes">Changes<span>${files.length}</span></button>
</div>

<div class="view" id="overview">
<section class="sec">
<header class="sec-h"><span class="sec-n num">01</span><div><h2>Summary</h2><p class="sec-note">Scope and intent of the change.</p></div></header>
<p class="meta-line"><b>jdeocampo99</b> wants to merge into <span class="num">main</span> · <span class="num">9b0411b</span> · <span class="num"><span class="plus">+${totalAdds}</span> <span class="minus">−${totalDels}</span></span> across ${files.length} files</p>
<p class="lead">Fixes three Claude Code harness bugs found after #254 to #257. The coordinator stops showing the model's follow-up directions, a worker stops running a turn when a background command finishes after its report, and resuming a coordinator quit before its first message now starts fresh under the same id instead of failing after 30 seconds.</p>
<p class="take"><b>Verdict:</b> Safe to merge once the two resume questions are answered.</p>
</section>

<section class="sec">
<header class="sec-h"><span class="sec-n num">02</span><div><h2>Code walkthrough</h2><p class="sec-note">Select a module for its explanation. Start the tour to step through all ${tour.length} stops in execution order.</p></div><button class="primary" data-tour="0">Start tour</button></header>
<div class="panel diagram" data-lavish-action><pre class="diagram-src" hidden>${esc(walkDiagram)}</pre><div class="diagram-out" id="diagram-out"></div><div class="pop" id="pop" hidden></div></div>
<div class="panel detail" id="detail"></div>
</section>
</div>

<div class="changes" id="changes" hidden>
${filesHtml}
</div>
<div class="tour" id="tour" hidden>
<div class="tour-top"><span class="tour-ch" id="tour-ch"></span><button class="x" data-tour-exit title="Exit tour (Esc)">✕</button></div>
<div class="trail" id="tour-trail"></div>
<h3 id="tour-title"></h3><p id="tour-body"></p><div id="tour-draft"></div>
<div class="tour-nav"><button class="link" data-tour-step="-1">← Back</button><span class="num" id="tour-count"></span><span class="pips" id="tour-pips"></span><button class="primary" data-tour-step="1" id="tour-next">Next →</button></div>
</div>
</main>

<aside class="review-pane">
<div style="display:flex;justify-content:space-between;align-items:center"><h2>Tandem's suggestions</h2><button class="x side-close" id="side-close" title="Close">✕</button></div>
<p class="sec-note">Tandem drafted these comments. Add the ones you agree with to your review. Nothing is posted until you submit it.</p>
<h3><span>Overall concerns</span></h3>
<div class="panel list">${overall.map((c) => `<div class="orow"><span class="sev" data-sev="${c.severity}">${c.severity}</span><b>${esc(c.title)}</b><p>${esc(c.detail)}</p></div>`).join("")}</div>
<h3><span>Suggested comments</span><span class="num" id="draft-count"></span></h3>
<div class="stack" id="side-drafts">${sortedDrafts.map((d) => draftCard(d, false)).join("")}</div>
<h3 id="yours-h" hidden><span>Your comments</span></h3>
<div class="stack" id="side-yours"></div>
<div class="spacer-y"></div>
<div class="post">
<p class="post-status" id="post-status"></p>
<div class="post-row"><button type="button" class="link" id="approve-all">Add all</button><button type="button" class="primary" data-finish>Finish your review</button></div>
</div>
</aside>
</div>

<dialog id="finish" class="finish">
<form id="post-form" method="dialog" data-lavish-question="pr-review-266">
<h2>Finish your review</h2>
<label class="f-label" for="f-summary">Summary comment <small>Posted as the review body. Edit freely.</small></label>
<textarea id="f-summary" rows="4">Looks good. Two questions on the resume path: what happens if Claude Code changes its transcript folder naming, and whether a permission error should count as "never saved".</textarea>
<fieldset class="f-verdicts">
<label><input type="radio" name="verdict" value="comment" checked><span><b>Comment</b><small>Submit general feedback without explicit approval.</small></span></label>
<label><input type="radio" name="verdict" value="approve"><span><b>Approve</b><small>Submit feedback and approve merging these changes.</small></span></label>
<label><input type="radio" name="verdict" value="request-changes"><span><b>Request changes</b><small>Submit feedback that must be addressed before merging.</small></span></label>
</fieldset>
<p class="f-summary-line" id="f-what"></p>
<div class="f-actions"><button type="button" class="link" data-finish-close>Cancel</button><button type="submit" class="primary" id="post">Submit review</button></div>
<p class="post-note">Submitting posts this review to GitHub. This is the last step.</p>
</form>
</dialog>

<dialog id="confirm"><h2>Post this review to #266?</h2><div id="confirm-body"></div>
<p class="hint">Mockup: nothing is sent. In Tandem this goes to the coordinator, which still asks for your yes.</p>
<form method="dialog" style="text-align:right;margin-top:12px"><button class="link">Close</button></form></dialog>

<script type="application/json" id="sources">${embedJson(nearHtml)}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
const SOURCES = JSON.parse(document.getElementById("sources").textContent);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const idFor = (p) => "f-" + p.replace(/[^A-Za-z0-9]/g, "-");

function moveInd() {
  const b = $('#tabs .tab[aria-selected="true"]'), ind = $("#tabs .tab-ind");
  ind.style.width = b.offsetWidth + "px"; ind.style.height = b.offsetHeight + "px";
  ind.style.transform = "translate(" + b.offsetLeft + "px," + b.offsetTop + "px)";
}
function showTab(name) {
  for (const t of document.querySelectorAll("#tabs .tab")) t.setAttribute("aria-selected", t.dataset.tab === name);
  $("#overview").hidden = name !== "overview";
  $("#changes").hidden = name !== "changes";
  moveInd();
}
function setOpen(section, open) {
  section.dataset.expanded = open;
  section.querySelector(".fold").setAttribute("aria-expanded", open);
}
function openFile(path, line) {
  const section = document.getElementById(idFor(path));
  if (!section) return;
  showTab("changes");
  setOpen(section, true);
  for (const b of document.querySelectorAll(".tree-file")) b.classList.toggle("on", b.dataset.open === path);
  const treeBtn = document.querySelector('.tree-file[data-open="' + CSS.escape(path) + '"]');
  if (treeBtn) treeBtn.closest(".dir").dataset.collapsed = "false";
  const row = line && document.getElementById(section.id + "-L" + line);
  requestAnimationFrame(() => {
    (row || section).scrollIntoView({ block: row ? "center" : "start", behavior: "smooth" });
    if (row) { row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); }
  });
}

function expand(gap, count) {
  const section = gap.closest(".file"), lines = SOURCES[section.dataset.path] || {};
  let from = +gap.dataset.from, to = +gap.dataset.to, budget = +gap.dataset.budget;
  const delta = +gap.dataset.delta, up = gap.dataset.dir === "up";
  const n = Math.min(count === "all" ? budget : +count, budget, to - from + 1);
  const a = up ? to - n + 1 : from, b = up ? to : from + n - 1;
  const rows = [];
  for (let i = a; i <= b; i++) rows.push('<tr class="ctx revealed" id="' + section.id + "-L" + i + '" data-line="' + i + '"><td class="no">' + (i + delta) + '</td><td class="no hook" data-lavish-action>' + i + '</td><td class="code">' + (lines[i] || " ") + "</td></tr>");
  gap.insertAdjacentHTML(up ? "afterend" : "beforebegin", rows.join(""));
  if (up) to = a - 1; else from = b + 1;
  budget -= n;
  if (to < from) return gap.remove();
  gap.dataset.from = from; gap.dataset.to = to; gap.dataset.budget = budget;
  const left = to - from + 1;
  if (budget === 0) {
    const url = "https://github.com/jdeocampo99/tandem/blob/9b0411b42ae4c6690bbd757e23a8619847fe52a1/" + section.dataset.path + "#L" + from + "-L" + to;
    gap.innerHTML = '<td colspan="2"></td><td class="gap-label"><span class="n">' + left + '</span> more line' + (left === 1 ? "" : "s") + ' · <a class="exp-all" data-lavish-action target="_blank" rel="noopener" href="' + url + '">View file on GitHub ↗</a></td>';
    return;
  }
  gap.querySelector(".n").textContent = left; gap.querySelector(".w").textContent = left === 1 ? "hidden line" : "hidden lines";
}

function setState(id, state) {
  for (const c of document.querySelectorAll('[data-draft="' + id + '"]')) {
    c.dataset.state = state;
    c.querySelector(".state").textContent = { approved: "Pending", skipped: "Dismissed", pending: "" }[state];
    const add = c.querySelector(".approve"); if (add) add.textContent = state === "approved" ? "Added ✓" : "Add to review";
  }
  update();
}
function update() {
  const all = document.querySelectorAll(".draft.side[data-draft]").length;
  const added = document.querySelectorAll('.draft.side[data-draft][data-state="approved"]').length;
  const undecided = document.querySelectorAll('.draft.side[data-draft][data-state="pending"]').length;
  const yours = document.querySelectorAll("#side-yours .draft").length;
  $("#draft-count").textContent = added + " of " + all + " added";
  $("#yours-h").hidden = yours === 0;
  $("#review-count").textContent = added + "/" + all;
  $("#finish-count").textContent = added + yours;
  const n = added + yours;
  $("#post-status").innerHTML = "<b>" + n + " comment" + (n === 1 ? "" : "s") + "</b> in your review" + (undecided ? " · " + undecided + " suggestion" + (undecided === 1 ? "" : "s") + " not reviewed yet" : "");
  $("#f-what").innerHTML = "<b>" + n + " line comment" + (n === 1 ? "" : "s") + "</b> will post with the summary" + (undecided ? ". " + undecided + " suggestion" + (undecided === 1 ? " you haven't" : "s you haven't") + " reviewed will be left out." : ".");
}

document.addEventListener("click", (e) => {
  const t = e.target;
  const ts = t.closest("[data-tour]"); if (ts) return startTour(+ts.dataset.tour);
  const step = t.closest("[data-tour-step]");
  if (step) { const i = at + +step.dataset.tourStep; return i >= TOUR.length ? endTour() : startTour(Math.max(0, i)); }
  if (t.closest("[data-tour-exit]")) return endTour();
  if (t.closest("[data-pop-close]")) return closePop();
  if (!$("#pop").hidden && !t.closest("#pop") && !t.closest("#diagram-out .node")) closePop();
  const tab = t.closest("[data-tab]"); if (tab) { if (tab.dataset.tab === "overview") endTour(); return showTab(tab.dataset.tab); }
  const dirBtn = t.closest(".dir-label");
  if (dirBtn) { const d = dirBtn.closest(".dir"); d.dataset.collapsed = d.dataset.collapsed !== "true"; return syncDirs(); }
  if (t.closest("#dirs-toggle")) { const open = anyDirOpen(); for (const d of document.querySelectorAll(".rail .dir")) d.dataset.collapsed = open; return syncDirs(); }
  const tree = t.closest("[data-open]"); if (tree) return openFile(tree.dataset.open);
  const fold = t.closest(".fold, [data-fold]");
  if (fold) { const s = fold.closest(".file"); return setOpen(s, s.dataset.expanded !== "true"); }
  const exp = t.closest("[data-expand]"); if (exp) return expand(exp.closest("tr.gap"), exp.dataset.expand);
  const act = t.closest("[data-act]");
  if (act) {
    const card = act.closest(".draft");
    if (card.dataset.draft && act.dataset.act === "edit") {
      const box = Object.assign(document.createElement("textarea"), { value: card.dataset.body });
      card.querySelector("p").replaceWith(box);
      card.querySelector("footer").innerHTML = '<button class="primary" data-act="save-edit">Save</button><button class="link" data-act="cancel-edit">Cancel</button>';
      box.focus();
      return;
    }
    if (card.dataset.draft && (act.dataset.act === "save-edit" || act.dataset.act === "cancel-edit")) {
      const text = act.dataset.act === "save-edit" ? card.querySelector("textarea").value.trim() || card.dataset.body : card.dataset.body;
      for (const c of document.querySelectorAll('[data-draft="' + card.dataset.draft + '"]')) {
        c.dataset.body = text;
        const p = Object.assign(document.createElement("p"), { innerHTML: esc(text).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>") });
        (c.querySelector("textarea") || c.querySelector("p")).replaceWith(p);
        c.querySelector("footer").innerHTML = '<button class="link approve" data-act="approve">Add to review</button><button class="link" data-act="skip">Dismiss</button><button class="link" data-act="edit">Edit</button>';
        if (act.dataset.act === "save-edit") c.querySelector(".by").lastChild.textContent = "Tandem · edited by you";
      }
      return act.dataset.act === "save-edit" ? setState(card.dataset.draft, "approved") : undefined;
    }
    if (card.dataset.draft) {
      const next = act.dataset.act === "approve" ? "approved" : "skipped";
      return setState(card.dataset.draft, card.dataset.state === next ? "pending" : next);
    }
    if (act.dataset.act === "save") {
      const text = card.querySelector("textarea").value.trim(); if (!text) return;
      card.querySelector("textarea").replaceWith(Object.assign(document.createElement("p"), { textContent: text }));
      card.dataset.state = "approved"; card.querySelector("footer").remove();
      card.querySelector(".state").textContent = "Pending";
      const copy = card.cloneNode(true); copy.classList.replace("inline", "side");
      $("#side-yours").append(copy);
    } else card.closest("tr").remove();
    return update();
  }
  const loc = t.closest("[data-file]"); if (loc) return openFile(loc.dataset.file, loc.dataset.line);
  const hook = t.closest("td.hook");
  if (hook) {
    const row = hook.closest("tr"); if (!row.dataset.line) return;
    const path = row.closest(".file").dataset.path;
    const note = document.createElement("tr"); note.className = "note";
    note.innerHTML = '<td colspan="3"><article class="draft inline yours"><header><span class="by"><i class="mark me">Y</i>You</span>' +
      '<button class="loc" data-file="' + esc(path) + '" data-line="' + row.dataset.line + '">' + esc(path.split("/").pop()) + ":" + row.dataset.line + '</button><span class="state"></span></header>' +
      '<textarea placeholder="Leave a comment"></textarea><footer><button class="primary" data-act="save">Add comment</button><button class="link" data-act="cancel">Cancel</button></footer></article></td>';
    row.after(note); note.querySelector("textarea").focus();
  }
});
document.addEventListener("change", (e) => {
  const p = e.target.dataset.viewed; if (!p) return;
  const section = e.target.closest(".file");
  setOpen(section, !e.target.checked);
  document.querySelector('.tree-file[data-open="' + CSS.escape(p) + '"]').classList.toggle("viewed", e.target.checked);
  $("#viewed-count").textContent = document.querySelectorAll(".tree-file.viewed").length;
  if (e.target.checked) {
    const main = $("#main");
    main.scrollBy({ top: section.getBoundingClientRect().top - main.getBoundingClientRect().top - 12, behavior: "smooth" });
  }
});
$("#approve-all").onclick = () => document.querySelectorAll(".draft.side[data-draft]").forEach((c) => setState(c.dataset.draft, "approved"));
const DIR_ICON = { collapse: ${JSON.stringify(COLLAPSE_ICON)}, expand: ${JSON.stringify(EXPAND_ICON)} };
const anyDirOpen = () => [...document.querySelectorAll(".rail .dir")].some((d) => d.dataset.collapsed !== "true");
function syncDirs() {
  const open = anyDirOpen(), b = $("#dirs-toggle"), label = open ? "Collapse all folders" : "Expand all folders";
  b.innerHTML = open ? DIR_ICON.collapse : DIR_ICON.expand; b.title = label; b.setAttribute("aria-label", label);
}
$("#rail-toggle").onclick = () => document.body.classList.add("rail-hidden");
$("#rail-open").onclick = () => document.body.classList.remove("rail-hidden");
$("#review-toggle").onclick = () => document.body.classList.toggle("review-open");
const openFinish = () => { document.body.classList.remove("review-open"); update(); $("#finish").showModal(); };
$("#finish-open").onclick = openFinish;
const LABEL = { comment: "Submit review", approve: "Approve and submit", "request-changes": "Request changes" };
$("#post-form").addEventListener("change", () => { $("#post").textContent = LABEL[new FormData($("#post-form")).get("verdict")]; });
const toTop = () => { const main = $("#main"); main.scrollTo({ top: 0, behavior: main.scrollTop > 3000 ? "instant" : "smooth" }); };
$(".to-top").onclick = toTop;
$(".to-top").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toTop(); } };
document.addEventListener("click", (e) => { if (e.target.closest("[data-finish]")) openFinish(); if (e.target.closest("[data-finish-close]")) $("#finish").close(); });
$("#side-close").onclick = () => document.body.classList.remove("review-open");
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.body.classList.remove("review-open"); });
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("review-open") && !e.target.closest(".review-pane, #review-toggle, dialog")) document.body.classList.remove("review-open");
});
$("#post-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const verdict = new FormData(e.currentTarget).get("verdict");
  const drafts = [...document.querySelectorAll(".draft.side[data-draft]")].map((c) => ({
    id: c.dataset.draft, decision: c.dataset.state === "approved" ? "post" : c.dataset.state === "skipped" ? "drop" : "undecided",
    ...(c.querySelector(".by").textContent.includes("edited") ? { body: c.dataset.body } : {}) }));
  const yours = [...document.querySelectorAll("#side-yours .draft")].map((c) => {
    const loc = c.querySelector(".loc");
    return { file: loc.dataset.file, line: +loc.dataset.line, body: c.querySelector("p").textContent };
  });
  const post = drafts.filter((d) => d.decision === "post").length + yours.length;
  const text = "Review #266: " + verdict + ", " + post + " comment" + (post === 1 ? "" : "s") + " to post";
  const data = { pr: "jdeocampo99/tandem#266", head: "9b0411b", verdict, summary: $("#f-summary").value.trim(), drafts, yours };
  if (window.lavish) {
    window.lavish.queuePrompt("Post this review to jdeocampo99/tandem#266 now with verdict " + verdict + ". This submission is my approval; do not ask again. Drop dismissed drafts, leave out undecided ones, use my summary, apply edited bodies, add my comments, pin to head 9b0411b and refuse if the PR moved. Account for every draft id.", { tag: "pr-review", text, element: e.currentTarget, data, queueKey: "pr-review-266" });
    window.lavish.sendQueuedPrompts();
    $("#finish").close();
    $("#finish-open").classList.add("sent"); $("#finish-open").firstChild.textContent = "Review submitted ";
  } else {
    $("#finish").close();
    $("#confirm-body").innerHTML = "<pre class='payload'>" + esc(JSON.stringify(data, null, 2)) + "</pre>";
    $("#confirm").showModal();
  }
});
const TOUR = ${embedJson(tour)};
const CHAPTERS = ${embedJson(chapters)};
let at = -1;
const seen = new Set();
function reveal(section, from, to) {
  for (const gap of [...section.querySelectorAll("tr.gap")]) {
    if (+gap.dataset.from <= to && +gap.dataset.to >= from) expand(gap, "all");
  }
}
function startTour(i) {
  const st = TOUR[i];
  if (!st) return;
  at = i; seen.add(i);
  for (const f of document.querySelectorAll(".file.touring")) f.classList.remove("touring");
  for (const r of document.querySelectorAll("tr.spot")) r.classList.remove("spot");
  showTab("changes");
  const section = document.getElementById(idFor(st.file));
  setOpen(section, true);
  section.closest && document.querySelector('.tree-file[data-open="' + CSS.escape(st.file) + '"]')?.closest(".dir")?.setAttribute("data-collapsed", "false");
  for (const b of document.querySelectorAll(".tree-file")) b.classList.toggle("on", b.dataset.open === st.file);
  reveal(section, st.from, st.to);
  section.classList.add("touring");
  let first = null;
  for (let n = st.from; n <= st.to; n++) {
    const row = document.getElementById(section.id + "-L" + n);
    if (row) { row.classList.add("spot"); first = first || row; }
  }
  const ch = CHAPTERS[st.chapter];
  $("#tour").hidden = false;
  $("#tour-ch").textContent = String.fromCharCode(65 + st.chapter) + " · " + ch.title;
  const inCh = TOUR.map((s, k) => [s, k]).filter(([s]) => s.chapter === st.chapter);
  $("#tour-trail").innerHTML = inCh.map(([s, k]) => '<button data-tour="' + k + '" class="' + (k === i ? "now" : seen.has(k) ? "done" : "") + '">' + esc(s.file.split("/").pop()) + '<span class="ln">:' + s.from + "</span></button>").join('<span class="arrow">→</span>');
  $("#tour-title").textContent = st.title;
  $("#tour-body").innerHTML = esc(st.body).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  $("#tour-draft").innerHTML = st.draft ? '<span class="has-draft"><i class="mark">T</i>Tandem left a comment on these lines</span>' : "";
  $("#tour-count").textContent = (i + 1) + " / " + TOUR.length;
  $("#tour-pips").innerHTML = TOUR.map((_, k) => '<i class="' + (k === i ? "on" : seen.has(k) ? "seen" : "") + '"></i>').join("");
  $("#tour-next").textContent = i === TOUR.length - 1 ? "Finish" : "Next →";
  requestAnimationFrame(() => {
    const main = $("#main"), r = (first || section).getBoundingClientRect(), m = main.getBoundingClientRect();
    main.scrollBy({ top: r.top - m.top - m.height * 0.22, behavior: "smooth" });
  });
}
const NODES = ${embedJson(nodes)};
function chapterOf(file) { const st = TOUR.find((x) => x.file === file); return st ? st.chapter : -1; }
function renderChapters() {
  $("#detail").innerHTML = CHAPTERS.map((ch, ci) => {
    const first = TOUR.findIndex((x) => x.chapter === ci), count = TOUR.filter((x) => x.chapter === ci).length;
    return '<div class="ch-row"><span class="ch-n num">' + String.fromCharCode(65 + ci) + '</span><div><b>' + esc(ch.title) + '</b><small>' + esc(ch.why) + '</small></div><span class="count">' + count + ' stop' + (count === 1 ? "" : "s") + '</span><button class="link" data-tour="' + first + '">Walk through</button></div>';
  }).join("");
}
window.pick = (id) => {
  const node = NODES.find((n) => n.id === id); if (!node) return;
  let el = null;
  for (const n of document.querySelectorAll("#diagram-out .node")) {
    const mine = n.id.split("-").includes(id);
    if (mine) el = n;
    n.classList.toggle("picked", mine); n.classList.toggle("dim", !mine);
  }
  const stops = TOUR.map((st, i) => [st, i]).filter(([st]) => st.file === node.file);
  const ci = chapterOf(node.file);
  const md = (t) => esc(t).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  const pop = $("#pop");
  pop.innerHTML = '<div class="pop-h"><div><span class="path">' + esc(node.file) + '</span><small>' +
    (ci >= 0 ? String.fromCharCode(65 + ci) + " · " + esc(CHAPTERS[ci].title) : "Supporting change, not on the tour") + '</small></div><button class="x" data-pop-close title="Close (Esc)">✕</button></div>' +
    (stops.length ? stops.map(([st, i]) => '<div class="pstop"><span class="stop-n num">' + (i + 1) + '</span><div><b>' + esc(st.title) + '</b><p>' + md(st.body) + '</p></div></div>').join("") : '<p class="pnone">Tandem has no tour stop in this file.</p>') +
    '<div class="pop-acts">' + (stops.length ? '<button class="primary" data-tour="' + stops[0][1] + '">Start tour here</button>' : "") + '<button class="link" data-file="' + esc(node.file) + '"' + (stops.length ? ' data-line="' + stops[0][0].from + '"' : "") + '>Open code</button></div>';
  pop.hidden = false;
  const box = $(".diagram").getBoundingClientRect(), r = el.getBoundingClientRect();
  const w = Math.min(380, box.width - 24);
  pop.style.width = w + "px";
  const left = Math.max(12, Math.min(r.left - box.left + r.width / 2 - w / 2, box.width - w - 12));
  const below = r.bottom - box.top + 10;
  pop.style.left = left + "px";
  pop.style.top = below + "px";
  pop.style.setProperty("--caret", (r.left - box.left + r.width / 2 - left) + "px");
  pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
};
function closePop() {
  $("#pop").hidden = true;
  for (const n of document.querySelectorAll("#diagram-out .node")) n.classList.remove("picked", "dim");
}
function endTour() {
  at = -1;
  $("#tour").hidden = true;
  for (const f of document.querySelectorAll(".file.touring")) f.classList.remove("touring");
  for (const r of document.querySelectorAll("tr.spot")) r.classList.remove("spot");
}
window.jump = (p) => {
  const i = TOUR.findIndex((s) => s.file === p);
  i >= 0 ? startTour(i) : openFile(p);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#pop").hidden) return closePop();
  if (at < 0 || e.target.closest("textarea, input")) return;
  if (e.key === "ArrowRight") { e.preventDefault(); at === TOUR.length - 1 ? endTour() : startTour(at + 1); }
  if (e.key === "ArrowLeft") { e.preventDefault(); startTour(Math.max(0, at - 1)); }
  if (e.key === "Escape") endTour();
});
addEventListener("resize", moveInd);
const css = getComputedStyle(document.documentElement);
mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "base", themeVariables: {
  fontFamily: "Plus Jakarta Sans, system-ui, sans-serif", fontSize: "13px", darkMode: true,
  background: css.getPropertyValue("--raise").trim(), primaryColor: css.getPropertyValue("--sunk").trim(),
  primaryTextColor: css.getPropertyValue("--ink").trim(), primaryBorderColor: css.getPropertyValue("--line2").trim(),
  lineColor: css.getPropertyValue("--faint").trim(), clusterBkg: css.getPropertyValue("--bg").trim(),
  clusterBorder: css.getPropertyValue("--line").trim(), titleColor: css.getPropertyValue("--muted").trim() } });
moveInd();
update();
mermaid.render("code-diagram", document.querySelector(".diagram-src").textContent).then(({ svg, bindFunctions }) => {
  const out = document.getElementById("diagram-out");
  out.innerHTML = svg;
  bindFunctions?.(out);
  for (const node of out.querySelectorAll(".node")) node.setAttribute("data-lavish-action", "");
});
renderChapters();
</script>
</body>
</html>`;

await Bun.write(`${dir}/index.html`, html);
console.log(`wrote ${files.length} files, ${Object.keys(sources).length} with sources, ${drafts.length} drafts`);
