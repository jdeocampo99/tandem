import { expect, test } from "bun:test";
import { createRequestBriefRecord, reviseRequestBriefRecord } from "../../src/requests/brief.ts";
import { briefView } from "../../src/requests/native-view.ts";
import { content, NOW } from "../board/fixtures.ts";

test("brief NEW markers detect changed lines without marking unchanged lines shifted by insertion", () => {
  const first = createRequestBriefRecord(
    {
      id: "req-native",
      repoPath: "/repo",
      content: { ...content("Use Tern"), scope: ["Launch tabs", "Close tabs", "Launch tabs"] },
    },
    NOW,
  );
  const second = reviseRequestBriefRecord(
    first,
    { ...first.draft.content, scope: ["Launch tabs", "Focus tabs", "Close tabs", "Launch tabs"] },
    "2030-01-01T12:05:00.000Z",
  );
  const view = briefView(second);
  expect(view.lines.filter((line) => line.isNew).map((line) => line.text)).toEqual(["Focus tabs"]);
  expect(view.changes).toBe(1);
  expect(view.approval).toEqual({
    requestId: first.id,
    briefRevision: 2,
    contentDigest: second.draft.contentDigest,
    agreementDigest: second.draft.agreementDigest,
  });
  expect(briefView(first).changes).toBe(0);
});

test("line comments remain under their exact revision line and unknown anchors are excluded", () => {
  const record = createRequestBriefRecord(
    { id: "req-native", repoPath: "/repo", content: content("Use Tern") },
    NOW,
  );
  const line = briefView(record).lines.find((line) => line.text === "Use Tern");
  expect(line).toBeDefined();
  const comments = [
    {
      id: "c1",
      requestId: record.id,
      briefRevision: record.draft.revision,
      contentDigest: record.draft.contentDigest,
      lineId: line?.id ?? "",
      body: "Keep Herdr",
      author: "you",
      at: NOW,
    },
    {
      id: "c2",
      requestId: record.id,
      briefRevision: record.draft.revision,
      contentDigest: record.draft.contentDigest,
      lineId: "missing",
      body: "stale",
      author: "you",
      at: NOW,
    },
  ];
  const view = briefView(record, comments, "http://127.0.0.1:4387/review");
  expect(view.commentCount).toBe(1);
  expect(view.lines.find((each) => each.id === line?.id)?.comments[0]?.body).toBe("Keep Herdr");
  expect(view.browserUrl).toContain("4387");
});

test("a deleted brief line counts as a change and comments from an older revision never reattach", () => {
  const first = createRequestBriefRecord(
    {
      id: "req-native",
      repoPath: "/repo",
      content: { ...content("Use Tern"), scope: ["Launch tabs", "Close tabs"] },
    },
    NOW,
  );
  const second = reviseRequestBriefRecord(
    first,
    { ...first.draft.content, scope: ["Close tabs"] },
    NOW,
  );
  const line = briefView(first).lines.find((line) => line.text === "Launch tabs");
  const comments = [
    {
      id: "c1",
      requestId: first.id,
      briefRevision: 1,
      contentDigest: first.draft.contentDigest,
      lineId: line?.id ?? "",
      body: "Old line",
      author: "you",
      at: NOW,
    },
  ];
  expect(briefView(second, comments).changes).toBe(1);
  expect(briefView(second, comments).commentCount).toBe(0);
});
