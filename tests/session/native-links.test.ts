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
    {
      role: "assistant",
      content:
        "Tern adapter (task 102) is ready. Review PR #281. Task 103 belongs to another project.",
    },
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
    [{ url: "tandem://task/102", label: "Task 102" }],
  );
  expect(
    nativeReplyLinks(
      [
        { role: "user", content: "task 102" },
        { role: "assistant", content: "Task 102", superseded: true },
        { role: "assistant", content: "Task 102", synthetic: true },
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
      [
        {
          role: "assistant",
          content:
            "Review brief req-282. Foreign brief req-other and task 103 stay outside this project.",
        },
      ],
      [],
      [brief, { ...brief, repoPath: "/foreign", id: "req-other" }],
      "/repo",
    ),
  ).toEqual([{ label: "Brief req-282", url: "tandem://brief/req-282" }]);
});

test("reply links do not infer identities from task titles, counts, issue numbers, or foreign PR URLs", () => {
  for (const text of [
    "Tern adapter is ready.",
    "Changed 102 files and discussed issue #281.",
    "Review https://github.com/foreign/repo/pull/281.",
    "task 1020, PR #2810, task-102, task102 and PR281.",
  ]) {
    expect(nativeReplyLinks([{ role: "assistant", content: text }], [record], [], "/repo")).toEqual(
      [],
    );
  }
  for (const text of [
    "Task #102; pull request #281.",
    "Task `102`; PR **281**.",
    "tandem://task/102; tandem://pr/281.",
  ]) {
    expect(
      nativeReplyLinks([{ role: "assistant", content: text }], [record], [], "/repo"),
    ).toHaveLength(2);
  }
  expect(
    nativeReplyLinks(
      [{ role: "assistant", content: record.pullRequest?.url ?? "" }],
      [record],
      [],
      "/repo",
    ),
  ).toEqual([{ url: "tandem://pr/281", label: "PR #281" }]);
});
