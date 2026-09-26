import { readFileSync } from "node:fs";
import type { ReportView } from "./model.ts";

/**
 * Turns the report view model into one self-contained HTML page. The page template, with its
 * styles and the small script that draws the task list from the embedded view, lives next to
 * this file so the markup stays readable; only the header text and the data are filled in here.
 */
const PAGE_TEMPLATE_URL = new URL("./page.html", import.meta.url);

const MAIN = `<section class="scope">
    <div class="tabs" id="filters" role="tablist" aria-label="Task type"></div>
    <div class="panel" id="stats" aria-label="Summary"></div>
  </section>
  <section style="margin-top:-16px">
    <div class="panel list">
      <div class="cols"><span>Task</span><span>Timeline</span><span>Time</span><span>Cost</span></div>
      <ul class="rows" id="rows"></ul>
    </div>
  </section>`;

const EMPTY = `<p class="empty">No tasks have timeline history yet in this range.</p>`;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function renderReportHtml(view: ReportView): string {
  const template = readFileSync(PAGE_TEMPLATE_URL, "utf8");
  const fills: Readonly<Record<string, string>> = {
    scope: escapeHtml(view.scopeLabel),
    range: escapeHtml(formatDateRange(reportStart(view), new Date(view.generatedAt))),
    main: view.tasks.length > 0 ? MAIN : EMPTY,
    data: `<script type="application/json" id="report-data">${embedJson(view)}</script>`,
  };
  return template.replace(/\{\{(scope|range|main|data)\}\}/g, (_match, key: string) => {
    const fill = fills[key];
    if (fill === undefined) throw new Error(`Report template has no value for ${key}`);
    return fill;
  });
}

/** `since`, or the earliest task's creation; the generation time when neither exists. */
function reportStart(view: ReportView): Date {
  if (view.since !== undefined) return new Date(view.since);
  const created = view.tasks.map((task) => Date.parse(task.createdAt));
  return new Date(created.length > 0 ? Math.min(...created) : Date.parse(view.generatedAt));
}

/** "Sep 12 – 26", "Aug 30 – Sep 26", "Dec 30, 2025 – Jan 2, 2026", or one day alone. */
function formatDateRange(start: Date, end: Date): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  const endLabel = `${MONTHS[end.getMonth()]} ${end.getDate()}`;
  if (sameMonth && start.getDate() === end.getDate()) return endLabel;
  if (!sameYear) {
    return `${MONTHS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} – ${endLabel}, ${end.getFullYear()}`;
  }
  const endText = sameMonth ? String(end.getDate()) : endLabel;
  return `${MONTHS[start.getMonth()]} ${start.getDate()} – ${endText}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON safe inside a `<script>` element: no `<`, `>`, or `&` can close it or open a comment. */
function embedJson(view: ReportView): string {
  return JSON.stringify(view)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}
