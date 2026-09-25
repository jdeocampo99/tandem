import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHomeSettings, saveWorkerSkills } from "../../src/config/home-settings.ts";

test("worker skills are saved once, an empty list for no, and never over what the user wrote", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-settings-"));
  try {
    expect(await readHomeSettings(home)).toEqual({
      workerSkills: [],
      workerSkillsChosen: false,
      selfImprovement: "off",
    });
    expect(await saveWorkerSkills(home, ["buildkite"])).toEqual({
      workerSkills: ["buildkite"],
      workerSkillsChosen: true,
      selfImprovement: "off",
    });
    await expect(saveWorkerSkills(home, [])).rejects.toThrow("already lists workerSkills");

    await writeFile(join(home, "settings.toml"), "# mine\n");
    expect(await saveWorkerSkills(home, [])).toEqual({
      workerSkills: [],
      workerSkillsChosen: true,
      selfImprovement: "off",
    });
    expect(await readFile(join(home, "settings.toml"), "utf8")).toBe("workerSkills = []\n# mine\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("self-improvement is off unless the user sets fix or report", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-settings-"));
  try {
    await writeFile(join(home, "settings.toml"), 'selfImprovement = "report"\n');
    expect((await readHomeSettings(home)).selfImprovement).toBe("report");
    await writeFile(join(home, "settings.toml"), 'selfImprovement = "yes"\n');
    await expect(readHomeSettings(home)).rejects.toThrow('must be "off", "fix", or "report"');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
