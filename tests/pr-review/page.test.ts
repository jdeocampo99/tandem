import { describe, expect, test } from "bun:test";
import {
  buildReviewPage,
  parseReviewSubmission,
  type ReviewPageInput,
  type ReviewSubmission,
} from "../../src/pr-review/page.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,3 +2,4 @@ export function a() {
 const one = 1;
-const two = 2;
+const two = 22;
+const three = 3;
 return one;
diff --git a/notes.unknownext b/notes.unknownext
index 333..444 100644
--- a/notes.unknownext
+++ b/notes.unknownext
@@ -1,2 +1,2 @@
 keep <b>this</b>
-old line
+new line
`;

const A_HEAD = [
  "export function a() {",
  "const one = 1;",
  "const two = 22;",
  "const three = 3;",
  "return one;",
  "}",
];
const A_BASE = ["export function a() {", "const one = 1;", "const two = 2;", "return one;", "}"];

const input: ReviewPageInput = {
  pr: {
    repo: "o/r",
    number: 7,
    title: "Fix <the> thing",
    url: "https://github.com/o/r/pull/7",
    author: "sam",
    baseRef: "main",
    head: "abcdef1234567",
  },
  intent: "Changes `a`.",
  verdict: "Safe to merge.",
  summaryComment: "Looks fine.",
  chapters: [
    {
      title: "The change",
      why: "It matters.",
      stops: [
        { file: "src/a.ts", from: 3, to: 4, title: "Two and three", body: "Why `two` moves." },
        { file: "notes.unknownext", from: 1, to: 1, title: "Notes", body: "Unrelated." },
      ],
    },
  ],
  drafts: [
    { id: "c1", file: "src/a.ts", line: 4, severity: "question", body: "UNIQUE-DRAFT-TEXT <ok>?" },
  ],
  concerns: [],
  notes: ["A muted note."],
  patch: PATCH,
  sources: {
    "src/a.ts": { head: `${A_HEAD.join("\n")}\n`, base: `${A_BASE.join("\n")}\n` },
    "notes.unknownext": {
      head: "keep <b>this</b>\nnew line\n",
      base: "keep <b>this</b>\nold line\n",
    },
  },
};

const valid: ReviewSubmission = {
  tandemPrReview: 1,
  verdict: "approve",
  summary: "ok",
  drafts: [
    { id: "c1", decision: "post" },
    { id: "c2", decision: "undecided", body: "edited" },
  ],
  yours: [{ file: "src/a.ts", line: 3, body: "mine" }],
};

function problemsOf(value: unknown): readonly string[] {
  const parsed = parseReviewSubmission(JSON.stringify(value));
  if (parsed.ok) throw new Error("expected the submission to be rejected");
  return parsed.problems;
}

describe("parseReviewSubmission", () => {
  test("accepts a valid submission and keeps edited bodies", () => {
    const parsed = parseReviewSubmission(JSON.stringify(valid));
    expect(parsed).toEqual({ ok: true, submission: valid });
  });

  test("rejects a missing marker", () => {
    const { tandemPrReview: _marker, ...rest } = valid;
    expect(problemsOf(rest).join("\n")).toContain("tandemPrReview");
  });

  test("rejects unknown keys at every level", () => {
    const problems = problemsOf({
      ...valid,
      extra: 1,
      drafts: [{ id: "c1", decision: "post", surprise: true }],
      yours: [{ file: "a", line: 1, body: "b", more: 1 }],
    }).join("\n");
    expect(problems).toContain('unknown key "extra"');
    expect(problems).toContain('unknown key "surprise"');
    expect(problems).toContain('unknown key "more"');
  });

  test("rejects a bad decision and bad verdict together", () => {
    const problems = problemsOf({
      ...valid,
      verdict: "merge",
      drafts: [{ id: "c1", decision: "maybe" }],
    });
    expect(problems.length).toBe(2);
  });

  test("rejects non-positive lines and empty bodies", () => {
    const problems = problemsOf({
      ...valid,
      yours: [
        { file: "a", line: 0, body: "x" },
        { file: "a", line: 1.5, body: "x" },
        { file: "a", line: 2, body: "  " },
      ],
    });
    expect(problems.length).toBe(3);
  });

  test("rejects text that is not JSON", () => {
    expect(parseReviewSubmission("{nope").ok).toBe(false);
  });
});

describe("buildReviewPage", () => {
  test("embeds the drafts, header facts, and the data file link", async () => {
    const { html } = await buildReviewPage(input, "review.files.json");
    expect(html).toContain("UNIQUE-DRAFT-TEXT &lt;ok&gt;?");
    expect(html).toContain("Fix &lt;the&gt; thing");
    expect(html).toContain("sam</b> wants to merge into");
    expect(html).toContain("abcdef1");
    expect(html).toContain("across 2 files");
    expect(html).toContain("Safe to merge.");
    expect(html).toContain("A muted note.");
    expect(html).toContain("review.files.json");
    expect(html).toContain('id="submit-review"');
  });

  test("omits the verdict line when there is no verdict", async () => {
    const { verdict: _verdict, ...rest } = input;
    const { html } = await buildReviewPage(rest, "f.json");
    expect(html).not.toContain("Verdict:");
  });

  test("the data file holds every head line, highlighted", async () => {
    const { files } = await buildReviewPage(input, "f.json");
    const parsed: Record<string, string[]> = JSON.parse(files);
    expect(parsed["src/a.ts"]?.length).toBe(A_HEAD.length);
    expect(parsed["src/a.ts"]?.[0]).toContain('<i class="k">export</i>');
    expect(parsed["notes.unknownext"]).toEqual(["keep &lt;b&gt;this&lt;/b&gt;", "new line"]);
  });

  test("offers a + only on new-side lines inside hunks", async () => {
    const { html } = await buildReviewPage(input, "f.json");
    const hooks = html.match(/class="no hook"/g) ?? [];
    // a.ts: 3 context + added rows (ctx, add, add, ctx) = 4, notes: ctx + add = 2.
    expect(hooks.length).toBe(6);
    const removed = [...html.matchAll(/<tr class="del"[^>]*>(.*?)<\/tr>/g)];
    expect(removed.length).toBe(2);
    for (const row of removed) expect(row[1]).not.toContain("hook");
  });

  test("a stop notes a Tandem comment only when a draft sits inside its range", async () => {
    const { html } = await buildReviewPage(input, "f.json");
    const data = /<script type="application\/json" id="page-data">(.*?)<\/script>/s.exec(html)?.[1];
    const stops: { title: string; hasDraft: boolean }[] = JSON.parse(data ?? "{}").tour;
    expect(stops.map((stop) => [stop.title, stop.hasDraft])).toEqual([
      ["Two and three", true],
      ["Notes", false],
    ]);
  });

  test("draws the walkthrough as plain HTML with no Mermaid and no inline token colours", async () => {
    const { html } = await buildReviewPage(input, "f.json");
    expect(html).not.toMatch(/mermaid/i);
    expect(html).not.toContain('style="color');
    expect(html).toContain('class="fbox"');
    expect(html).toContain('data-file="src/a.ts"');
  });

  test("removed lines are highlighted from the base source", async () => {
    const { html } = await buildReviewPage(input, "f.json");
    expect(html).toContain('<tr class="del" data-line=""><td class="no">3</td>');
    expect(html).toContain('<i class="c">2</i>');
  });

  test("the page scrolls as a document and hides closed overlays from focus", async () => {
    const { html } = await buildReviewPage(input, "f.json");
    expect(html).not.toMatch(/body\{[^}]*overflow:hidden/);
    expect(html).not.toMatch(/\.mainpane\{[^}]*overflow:auto/);
    expect(html).toContain(
      '$(".review-pane").inert = drawerMode.matches && !document.body.classList.contains',
    );
    expect(html).toContain('<div class="tour" id="tour" hidden>');
    expect(html).toContain('<div class="pop" id="pop" hidden>');
    expect(html).not.toContain("showModal");
  });
});
