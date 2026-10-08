import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PresentationRecord,
  readAbsolutePath,
  readPresentationRecord,
  readSingleLine,
  readText,
} from "../../src/presentations/records.ts";

const record = {
  id: " id ",
  taskId: " task ",
  generation: 0,
  cwd: "/tmp/artifacts ",
  artifactPath: "/tmp/artifacts /artifact.html ",
  status: "open",
  createdAt: " time ",
  updatedAt: " time ",
  question: { id: " question ", text: " Question? ", recommendation: " Yes " },
  pendingNotification: { id: " notification ", message: " message ", kind: "coordinator" },
  objective: " objective ",
  pendingFeedback: [" feedback "],
} satisfies PresentationRecord;

test("presentation field readers trim before the single-line check and keep their messages", () => {
  expect(readText(" \ntext\n ", "field")).toBe("text");
  expect(readSingleLine("\n text \n", "field")).toBe("text");
  expect(readAbsolutePath("\n /tmp/a/../b \n", "path")).toBe("/tmp/b");
  expect(() => readText(" ", "field")).toThrow(
    new TypeError("field must be non-empty text without NUL characters"),
  );
  expect(() => readSingleLine("a\nb", "field")).toThrow(
    new TypeError("field must be single-line value"),
  );
});

test("presentation record reads trim fields while preserving path whitespace and parser errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-record-parsers-"));
  const path = join(root, "record.json");
  try {
    await writeFile(path, JSON.stringify(record));
    expect(await readPresentationRecord(path)).toEqual({
      ...record,
      id: "id",
      taskId: "task",
      createdAt: "time",
      updatedAt: "time",
      question: { id: "question", text: "Question?", recommendation: "Yes" },
      pendingNotification: { id: "notification", message: "message", kind: "coordinator" },
      objective: "objective",
      pendingFeedback: ["feedback"],
    });
    for (const [overrides, message] of [
      [{ id: "a\nb" }, `${path}.id must be single-line`],
      [{ id: "\0" }, `${path}.id must be non-empty text without NUL characters`],
      [{ cwd: "" }, `${path}.cwd must be non-empty path without NUL characters`],
      [{ cwd: "/tmp/a\nb" }, `${path}.cwd must not contain control characters`],
      [{ status: "unknown" }, `${path}.status is invalid`],
      [{ generation: "0" }, `${path}.generation must be a non-negative integer`],
    ] as const) {
      await writeFile(path, JSON.stringify({ ...record, ...overrides }));
      await expect(readPresentationRecord(path)).rejects.toThrow(new TypeError(message));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
