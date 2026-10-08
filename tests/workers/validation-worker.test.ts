import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseValidationJob,
  readValidationResult,
  type ValidationJob,
  type ValidationResult,
} from "../../src/validation-worker.ts";

const job = {
  schemaVersion: 1,
  id: " id ",
  taskId: "task",
  generation: 0,
  repoPath: "/tmp/a/../repo ",
  head: "head",
  contract: "final",
  policyDigest: "policy",
  surfaces: ["test"],
  commands: [{ name: "test", argv: ["bun", "test"], surfaces: ["test"], timeoutMs: 1 }],
  resultPath: "/tmp/result.json",
  execution: {
    schemaVersion: 1,
    home: "/tmp/home",
    operationId: "operation",
    fencingRevision: 1,
    claimOwner: "owner",
  },
} satisfies ValidationJob;

test("validation job parsing preserves whitespace and its single-line errors", () => {
  expect(parseValidationJob(job)).toEqual({ ...job, repoPath: "/tmp/repo " });
  for (const [overrides, message] of [
    [{ id: "a\nb" }, "id must be single-line"],
    [{ id: " " }, "id must be a non-empty string without NUL characters"],
    [{ repoPath: "/tmp/a\nb" }, "repoPath must be single-line"],
    [{ generation: "0" }, "generation must be a non-negative integer"],
    [
      { commands: [{ ...job.commands[0], timeoutMs: 0 }] },
      "commands[0].timeoutMs must be a positive integer",
    ],
    [
      { execution: { ...job.execution, fencingRevision: 0 } },
      "execution.fencingRevision must be a positive integer",
    ],
  ] as const) {
    expect(() => parseValidationJob({ ...job, ...overrides })).toThrow(new TypeError(message));
  }
});

test("validation result parsing preserves negative exit codes and rejects non-integers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-validation-parsers-"));
  const path = join(root, "result.json");
  const result = {
    schemaVersion: 1,
    id: " id ",
    taskId: "task",
    generation: 0,
    head: "head",
    contract: "final",
    policyDigest: "policy",
    status: "failed",
    finishedAt: " time ",
    error: " error ",
    evidence: [
      {
        name: "test",
        argv: [],
        exitCode: -1,
        stdout: "",
        stderr: "",
        head: "head",
        contract: "final",
        origin: "local",
        policyDigest: "policy",
      },
    ],
  } satisfies ValidationResult;
  try {
    await writeFile(path, JSON.stringify(result));
    expect(await readValidationResult(path, result)).toEqual(result);
    await writeFile(
      path,
      JSON.stringify({ ...result, evidence: [{ ...result.evidence[0], exitCode: "0" }] }),
    );
    await expect(readValidationResult(path, result)).rejects.toThrow(
      new TypeError("evidence[0].exitCode must be an integer"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
