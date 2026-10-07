import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { RequestBriefContent } from "../../src/contracts.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { changeHomeSpecialist } from "../../src/specialists/home-files.ts";
import { specialistFileRevision } from "../../src/specialists/registry.ts";
import { withScenario } from "./scenario.ts";

const BRIEF: RequestBriefContent = {
  goal: "Speed up the scheduler",
  scope: ["src/scheduler.ts"],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: ["bun test passes"],
  manualVerification: [],
  recommendedApproach: "Cache the next deadline",
  keyDecisions: [],
  openQuestions: [],
  researchLinks: [],
};

test("sharing a specialist from Settings starts its own task awaiting approval, even beside an approved request", async () => {
  await withScenario({}, async (world) => {
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    await service.approveRequestBrief({
      requestId: drafted.record.id,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    const notes = await changeHomeSpecialist(world.home, {
      op: "create",
      name: "release-notes",
      fields: { label: "Release notes", instructions: "Group merged PRs.", steps: ["Collect PRs"] },
    });
    const text = await readFile(notes.path, "utf8");
    const revision = specialistFileRevision(await readFile(notes.path));

    await expect(
      service.shareSpecialist(world.repoPath, {
        name: "release-notes",
        revision: "0".repeat(64),
        target: world.repoPath,
      }),
    ).rejects.toThrow("changed on disk since Settings showed it");
    const shared = await service.shareSpecialist(world.repoPath, {
      name: "release-notes",
      revision,
      target: world.repoPath,
    });

    expect(shared.kind).toBe("implementation");
    expect(shared.stage).toBe("awaiting-approval");
    expect(shared.requestId).toBeUndefined();
    expect(shared.specialist?.name).toBe("general");
    expect(shared.objective).toContain(`\`\`\`markdown\n${text}\`\`\``);
    expect(shared.acceptanceCriteria).toContain(
      "`.tandem/specialists/release-notes.md` has exactly the content in the objective",
    );

    // The coordinator's own create would have joined that request; the share did not.
    const joined = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "Cache the next deadline",
      acceptanceCriteria: ["bun test passes"],
      surfaces: ["src"],
    });
    expect(joined.requestId).toBe(drafted.record.id);
    await service.shutdown();
  });
});
