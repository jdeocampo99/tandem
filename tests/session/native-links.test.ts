import { expect, test } from "bun:test";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { nativeLinkLine, nativeReplyLinks } from "../../src/session/native-links.ts";
import { content, NOW } from "../board/fixtures.ts";
import { task } from "./fixtures.ts";

const record = task({
  id: "102",
  repoPath: "/repo",
  title: "Tern adapter",
  pullRequest: {
    number: 281,
    repository: "owner/repo",
    head: "feature",
    base: "main",
    url: "https://github.com/owner/repo/pull/281",
    state: "draft",
  },
});
test("coordinator reply references resolve only known tasks and unambiguous PRs in its project", () => {
  const messages = [
    { role: "assistant", content: "Tern adapter (task 102) is ready. Review PR #281." },
  ];
  const links = nativeReplyLinks(
    messages,
    [record, task({ id: "103", repoPath: "/other" })],
    [],
    "/repo",
  );
  expect(links).toEqual([
    { url: "tandem://task/102", label: "Task 102" },
    { url: "tandem://pr/281", label: "PR #281" },
  ]);
  expect(nativeLinkLine(links)).toContain("\x1b]8;;tandem://task/102\x1b\\Task 102\x1b]8;;\x1b\\");
  expect(
    nativeReplyLinks([{ role: "assistant", content: "1020 and PR #2810" }], [record], [], "/repo"),
  ).toEqual([]);
  expect(nativeReplyLinks(messages, [record, task({ ...record, id: "104" })], [], "/repo")).toEqual(
    [
      { url: "tandem://task/102", label: "Task 102" },
      { url: "tandem://task/104", label: "Task 104" },
    ],
  );
  expect(
    nativeReplyLinks(
      [
        { role: "user", content: "task 102" },
        { role: "assistant", content: "102", superseded: true },
      ],
      [record],
      [],
      "/repo",
    ),
  ).toEqual([]);
});

test("brief references use the mentioned revision identity and reject foreign briefs", () => {
  const brief = createRequestBriefRecord(
    { id: "req-282", repoPath: "/repo", content: content("Support Tern") },
    NOW,
  );
  expect(
    nativeReplyLinks(
      [{ role: "assistant", content: "Review brief req-282." }],
      [],
      [brief, { ...brief, repoPath: "/foreign", id: "req-other" }],
      "/repo",
    ),
  ).toEqual([{ label: "Brief req-282", url: "tandem://brief/req-282" }]);
});
