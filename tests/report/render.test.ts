import { expect, test } from "bun:test";
import type { ReportTask, ReportView } from "../../src/report/model.ts";
import { renderReportHtml } from "../../src/report/render.ts";

const MIN = 60_000;

const stuckTask: ReportTask = {
  id: "t-31c0",
  title: "Fix stale pane after tandem update",
  kind: "implementation",
  stage: "completed",
  status: "completed",
  createdAt: "2026-09-23T12:00:00.000Z",
  wallMs: 170 * MIN,
  buckets: { working: 71 * MIN, "waiting-on-you": 0, "held-up": 99 * MIN },
  segments: [
    { lane: "queued", stage: "queued", startMs: 0, endMs: 2 * MIN },
    { lane: "implement", stage: "implementing", startMs: 2 * MIN, endMs: 30 * MIN },
    { lane: "validate", stage: "validating", startMs: 30 * MIN, endMs: 52 * MIN },
    { lane: "stuck", stage: "blocked", startMs: 52 * MIN, endMs: 149 * MIN },
    { lane: "validate", stage: "validating", startMs: 149 * MIN, endMs: 158 * MIN },
    { lane: "review", stage: "reviewing", startMs: 158 * MIN, endMs: 170 * MIN },
  ],
  lanes: [
    { lane: "implement", durationMs: 28 * MIN, costMicros: 1_120_000 },
    { lane: "validate", durationMs: 31 * MIN },
    { lane: "review", durationMs: 12 * MIN, costMicros: 740_000 },
    { lane: "queued", durationMs: 2 * MIN },
    { lane: "stuck", durationMs: 97 * MIN },
  ],
  runs: [
    {
      workKind: "implementation",
      role: "implementer",
      model: "sonnet",
      generation: 1,
      startMs: 2 * MIN,
      endMs: 30 * MIN,
      status: "succeeded",
      costMicros: 1_120_000,
    },
    { workKind: "validation", startMs: 30 * MIN, endMs: 52 * MIN, status: "timed-out" },
    { workKind: "validation", startMs: 149 * MIN, endMs: 158 * MIN, status: "succeeded" },
    {
      workKind: "review",
      role: "reviewer",
      model: "opus",
      startMs: 158 * MIN,
      endMs: 170 * MIN,
      status: "succeeded",
      costMicros: 740_000,
    },
  ],
  costMicros: 1_860_000,
  unpricedSamples: 0,
  choke: {
    kind: "stuck",
    startMs: 52 * MIN,
    endMs: 149 * MIN,
    headline: "Stuck 1h 37m in validation",
    explanation: "Validation timed out on the pane check. Nothing moved until you restarted it.",
  },
  lostMs: 99 * MIN,
};

const scoutTask: ReportTask = {
  id: "t-a77e",
  title: "Research: OMP compaction limits",
  kind: "scout",
  stage: "completed",
  status: "completed",
  createdAt: "2026-09-12T12:00:00.000Z",
  wallMs: 122 * MIN,
  buckets: { working: 37 * MIN, "waiting-on-you": 84 * MIN, "held-up": 1 * MIN },
  segments: [
    { lane: "queued", stage: "queued", startMs: 0, endMs: 1 * MIN },
    { lane: "research", stage: "scouting", startMs: 1 * MIN, endMs: 38 * MIN },
    { lane: "waiting-on-you", stage: "awaiting-approval", startMs: 38 * MIN, endMs: 122 * MIN },
  ],
  lanes: [
    { lane: "research", durationMs: 37 * MIN, costMicros: 290_000 },
    { lane: "queued", durationMs: 1 * MIN },
    { lane: "waiting-on-you", durationMs: 84 * MIN },
  ],
  runs: [
    {
      workKind: "research",
      role: "scout",
      model: "jev",
      startMs: 1 * MIN,
      endMs: 38 * MIN,
      status: "succeeded",
      costMicros: 70_000,
    },
    {
      workKind: "presentation",
      role: "presentation",
      model: "sonnet",
      startMs: 30 * MIN,
      endMs: 38 * MIN,
      status: "succeeded",
      costMicros: 220_000,
    },
  ],
  costMicros: 290_000,
  unpricedSamples: 0,
  choke: {
    kind: "waiting-on-you",
    startMs: 38 * MIN,
    endMs: 122 * MIN,
    headline: "Waited 1h 24m on your answer",
  },
  lostMs: 85 * MIN,
};

const mergedTask: ReportTask = {
  id: "t-8f2a",
  title: "Add --json to tandem watch",
  kind: "implementation",
  stage: "ready",
  status: "merged",
  createdAt: "2026-09-24T12:00:00.000Z",
  wallMs: 70 * MIN,
  buckets: { working: 66 * MIN, "waiting-on-you": 0, "held-up": 4 * MIN },
  segments: [
    { lane: "queued", stage: "queued", startMs: 0, endMs: 4 * MIN },
    { lane: "implement", stage: "implementing", startMs: 4 * MIN, endMs: 45 * MIN },
    { lane: "validate", stage: "validating", startMs: 45 * MIN, endMs: 52 * MIN },
    { lane: "review", stage: "reviewing", startMs: 52 * MIN, endMs: 62 * MIN },
    { lane: "implement", stage: "awaiting-fixes", startMs: 62 * MIN, endMs: 70 * MIN },
  ],
  lanes: [
    { lane: "implement", durationMs: 49 * MIN, costMicros: 2_550_000 },
    { lane: "validate", durationMs: 7 * MIN },
    { lane: "review", durationMs: 10 * MIN, costMicros: 960_000 },
    { lane: "queued", durationMs: 4 * MIN },
  ],
  runs: [
    {
      workKind: "implementation",
      role: "implementer",
      model: "sonnet",
      generation: 2,
      startMs: 62 * MIN,
      endMs: 70 * MIN,
      status: "succeeded",
      costMicros: 710_000,
    },
  ],
  unpricedSamples: 0,
  lostMs: 4 * MIN,
};

function view(tasks: readonly ReportTask[]): ReportView {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-26T12:00:00.000Z",
    since: "2026-09-12T12:00:00.000Z",
    scopeLabel: "jdeocampo99/tandem",
    tasks,
    unreadableEvents: 0,
  };
}

function embeddedData(html: string): unknown {
  const match = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  if (match?.[1] === undefined) throw new Error("report data script missing");
  return JSON.parse(match[1]);
}

test("renders a complete document with the title, scope, and date range", () => {
  const html = renderReportHtml(view([stuckTask, scoutTask, mergedTask]));
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain('<meta name="viewport"');
  expect(html).toContain("<title>Tandem report</title>");
  expect(html).toContain("<b>jdeocampo99/tandem</b> · Sep 12 – 26");
  expect(html).toContain('id="rows"');
  expect(html).not.toContain("{{");
});

test("embeds the view as JSON that parses back to the same view", () => {
  const report = view([stuckTask, scoutTask, mergedTask]);
  expect(embeddedData(renderReportHtml(report))).toEqual(report);
});

test("task text cannot close the data script or inject markup", () => {
  const hostile = "</script><img src=x onerror=alert(1)><!-- & $& $1";
  const report: ReportView = {
    ...view([{ ...stuckTask, title: hostile, id: "</SCRIPT>" }]),
    scopeLabel: "<b>scope</b>",
  };
  const html = renderReportHtml(report);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<!--");
  expect(html.toLowerCase().match(/<\/script>/g)).toHaveLength(2);
  expect(html).toContain("<b>&lt;b&gt;scope&lt;/b&gt;</b>");
  expect(embeddedData(html)).toEqual(report);
});

test("dates the range from the earliest task when no lower bound was given", () => {
  const { since: _since, ...unbounded } = view([stuckTask, scoutTask]);
  expect(renderReportHtml({ ...unbounded, generatedAt: "2026-10-03T12:00:00.000Z" })).toContain(
    "· Sep 12 – Oct 3",
  );
});

test("a pr-open task has its own icon, periwinkle color, and PR open tooltip", () => {
  const prOpen: ReportTask = { ...mergedTask, id: "t-pr01", status: "pr-open" };
  const html = renderReportHtml(view([prOpen]));
  expect(embeddedData(html)).toEqual(view([prOpen]));
  const icons = /const ICON=\{([\s\S]*?)\};/u.exec(html)?.[1] ?? "";
  const iconSvg = (status: string) =>
    new RegExp(`"?${status}"?:\`(<svg[\\s\\S]*?</svg>)\``, "u").exec(icons)?.[1];
  expect(iconSvg("pr-open")).toContain('stroke="currentColor"');
  expect(iconSvg("pr-open")).not.toBe(iconSvg("merged"));
  expect(iconSvg("pr-open")).not.toBe(iconSvg("in-progress"));
  expect(html).toContain('"pr-open":"var(--implement)"');
  expect(html).toContain('"pr-open":"PR open"');
});

test("shows one quiet line when no task has timeline history in range", () => {
  const html = renderReportHtml(view([]));
  expect(html).toContain("<h1>Tandem report</h1>");
  expect(html).toContain("No tasks have timeline history yet in this range.");
  expect(html).not.toContain('id="rows"');
  expect(embeddedData(html)).toEqual(view([]));
});
