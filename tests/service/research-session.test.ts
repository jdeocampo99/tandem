import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResearchFollowUpFiles,
  readResearchFollowUpAnswer,
} from "../../src/service/research-session.ts";

test("research follow-up sidecars are stable, job-confined, and decision-bound", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-research-session-"));
  try {
    const jobDirectory = join(home, "jobs", "scout-1", "run");
    await mkdir(jobDirectory, { recursive: true });
    const input = {
      home,
      taskId: "scout-1",
      jobPath: join(jobDirectory, "job.json"),
      decisionId: "decision-1",
      brief: "Use only the completed research report.",
    };
    const files = await createResearchFollowUpFiles(input);
    const repeated = await createResearchFollowUpFiles(input);

    expect(repeated).toEqual(files);
    expect(await readFile(files.briefPath, "utf8")).toBe(input.brief);
    await expect(
      createResearchFollowUpFiles({ ...input, brief: "A different prompt." }),
    ).rejects.toThrow("different or unsafe content");
    const outsideJobDirectory = join(home, "outside", "run");
    await mkdir(outsideJobDirectory, { recursive: true });
    await expect(
      createResearchFollowUpFiles({
        ...input,
        jobPath: join(outsideJobDirectory, "job.json"),
        decisionId: "outside",
      }),
    ).rejects.toThrow("outside its task's durable job directory");
    expect(await readResearchFollowUpAnswer(files.resultPath, input.decisionId)).toBeUndefined();

    await writeFile(
      files.resultPath,
      JSON.stringify({ schemaVersion: 1, decisionId: input.decisionId, answer: "Pinned commit." }),
    );
    expect(await readResearchFollowUpAnswer(files.resultPath, input.decisionId)).toBe(
      "Pinned commit.",
    );
    await writeFile(
      files.resultPath,
      JSON.stringify({ schemaVersion: 1, decisionId: "another-decision", answer: "Wrong." }),
    );
    await expect(readResearchFollowUpAnswer(files.resultPath, input.decisionId)).rejects.toThrow(
      "belongs to another decision",
    );
    await writeFile(files.resultPath, "x".repeat(30_000));
    await expect(readResearchFollowUpAnswer(files.resultPath, input.decisionId)).rejects.toThrow(
      "size limit",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
