import type { DraftComment } from "./review.ts";
import type { PrReviewRound, PrReviewState } from "./state.ts";

/** Small reviews read fine in chat; anything with a diagram or many comments gets the page. */
export function wantsPage(round: PrReviewRound): boolean {
  return round.review.diagram !== undefined || round.review.comments.length > 5;
}

/** The review as plain text for chat and for the task report. */
export function renderReviewText(state: PrReviewState, round: PrReviewRound): string {
  const { review } = round;
  const lines = [
    `${state.ref.repo}#${state.ref.number}: ${state.title}`,
    "",
    "What it does and why",
    review.intent,
  ];
  if (review.readingOrder.length > 0) {
    lines.push("", "How to read it");
    review.readingOrder.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.file}: ${entry.why}`);
    });
  }
  lines.push("", "Concerns");
  if (review.concerns.length === 0) lines.push("None.");
  for (const concern of review.concerns) {
    lines.push(`- [${concern.severity}] ${concern.title}: ${concern.detail}`);
  }
  if (review.priorComments.length > 0) {
    lines.push("", "Your earlier comments");
    for (const prior of review.priorComments) {
      lines.push(
        `- comment ${prior.commentId}: ${prior.status.replace("-", " ")}${prior.reply === undefined ? "" : ` (reply: "${prior.reply}")`}`,
      );
    }
  }
  lines.push("", "Draft comments");
  if (review.comments.length === 0) lines.push("None inline.");
  for (const comment of review.comments) {
    lines.push(`- ${comment.id} ${comment.file}:${comment.line} [${comment.severity}]`);
    lines.push(...comment.body.split("\n").map((line) => `    ${line}`));
  }
  if (review.summaryComment.length > 0) {
    lines.push("", "Review summary to post", review.summaryComment);
  }
  if (round.notes.length > 0) lines.push("", ...round.notes);
  if (round.posted !== undefined) lines.push("", `Posted: ${round.posted.url}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The review page opened in Lavish. Code fills a fixed template; the model never writes HTML.
 * ponytail: Mermaid loads from jsDelivr, so the diagram needs a network connection.
 */
export function renderReviewHtml(state: PrReviewState, round: PrReviewRound): string {
  const { review } = round;
  const title = `${state.ref.repo}#${state.ref.number}`;
  const section = (heading: string, body: string): string =>
    `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`;
  const parts = [
    `<header><p class="kicker">${escapeHtml(title)} · ${escapeHtml(state.author)}</p><h1>${escapeHtml(state.title)}</h1><p class="meta">Reviewed ${escapeHtml(round.head.slice(0, 12))} · <a href="${escapeHtml(state.url)}">Open on GitHub</a></p></header>`,
    section("What it does and why", `<p>${escapeHtml(review.intent)}</p>`),
  ];
  if (review.diagram !== undefined) {
    parts.push(
      section(
        "How the change flows",
        `<pre class="mermaid">${escapeHtml(review.diagram)}\nclassDef changed fill:#fde68a,stroke:#b45309,color:#1c1917</pre>`,
      ),
    );
  }
  if (review.readingOrder.length > 0) {
    parts.push(
      section(
        "How to read it",
        `<ol>${review.readingOrder.map((entry) => `<li><code>${escapeHtml(entry.file)}</code> ${escapeHtml(entry.why)}</li>`).join("")}</ol>`,
      ),
    );
  }
  parts.push(
    section(
      "Concerns",
      review.concerns.length === 0
        ? "<p>None.</p>"
        : `<ul class="concerns">${review.concerns.map((concern) => `<li><span class="tag ${concern.severity}">${concern.severity}</span><strong>${escapeHtml(concern.title)}</strong><p>${escapeHtml(concern.detail)}</p></li>`).join("")}</ul>`,
    ),
  );
  if (review.priorComments.length > 0) {
    parts.push(
      section(
        "Your earlier comments",
        `<ul>${review.priorComments.map((prior) => `<li>Comment ${prior.commentId}: ${escapeHtml(prior.status.replace("-", " "))}${prior.reply === undefined ? "" : ` · reply: “${escapeHtml(prior.reply)}”`}</li>`).join("")}</ul>`,
      ),
    );
  }
  parts.push(
    section(
      "Draft comments",
      review.comments.length === 0
        ? "<p>None inline.</p>"
        : review.comments.map(renderCommentCard).join(""),
    ),
  );
  if (review.summaryComment.length > 0) {
    parts.push(
      section(
        "Review summary to post",
        `<div class="comment">${paragraphs(review.summaryComment)}</div>`,
      ),
    );
  }
  if (round.notes.length > 0) {
    parts.push(`<p class="meta">${round.notes.map(escapeHtml).join(" ")}</p>`);
  }
  return page(title, parts.join("\n"), review.diagram !== undefined);
}

function renderCommentCard(comment: DraftComment): string {
  return `<article class="comment" data-comment-id="${escapeHtml(comment.id)}"><p class="where"><span class="tag ${comment.severity}">${comment.severity}</span><code>${escapeHtml(comment.file)}:${comment.line}</code> <span class="id">${escapeHtml(comment.id)}</span></p>${paragraphs(comment.body)}</article>`;
}

/** Keeps fenced blocks (such as GitHub suggestions) as code and the rest as paragraphs. */
function paragraphs(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith("```")
        ? `<pre><code>${escapeHtml(part.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""))}</code></pre>`
        : part
            .split(/\n{2,}/)
            .filter((chunk) => chunk.trim().length > 0)
            .map((chunk) => `<p>${escapeHtml(chunk.trim())}</p>`)
            .join(""),
    )
    .join("");
}

function page(title: string, body: string, diagram: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} review</title>
<style>
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --card:#ffffff; --line:#e7e5e4; --accent:#b45309;
  --blocking:#b91c1c; --question:#1d4ed8; --suggestion:#047857; --nit:#57534e; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --card:#292524;
  --line:#44403c; --accent:#fbbf24; --blocking:#f87171; --question:#93c5fd; --suggestion:#6ee7b7; --nit:#a8a29e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 4px 0 8px; line-height: 1.25; }
h2 { font-size: 1.05rem; margin: 32px 0 12px; color: var(--accent); }
.kicker, .meta { color: var(--muted); margin: 0; font-size: .9rem; }
a { color: inherit; }
code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow-x: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.comment { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin: 0 0 12px; }
.comment p { margin: 8px 0; }
.where { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0; }
.id { color: var(--muted); font-size: .8rem; }
.tag { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.tag.blocking { color: var(--blocking); } .tag.question { color: var(--question); }
.tag.suggestion { color: var(--suggestion); } .tag.nit { color: var(--nit); }
.concerns { list-style: none; padding: 0; } .concerns li { margin: 0 0 14px; }
.concerns .tag { margin-right: 8px; } .concerns p { margin: 4px 0 0; }
.mermaid { background: var(--card); text-align: center; }
</style>
</head>
<body>
<main>
${body}
</main>
${diagram ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n<script>mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });</script>' : ""}
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
