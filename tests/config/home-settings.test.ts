import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHomeSettings,
  saveProjectRoots,
  saveSelfImprovement,
  saveWorkerSkills,
} from "../../src/config/home-settings.ts";

test("worker skills are saved once, an empty list for no, and never over what the user wrote", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-settings-"));
  try {
    expect(await readHomeSettings(home)).toEqual({
      workerSkills: [],
      workerSkillsChosen: false,
      selfImprovement: "off",
      selfImprovementChosen: false,
      projectRoots: [],
    });
    expect(await saveWorkerSkills(home, ["buildkite"])).toEqual({
      workerSkills: ["buildkite"],
      workerSkillsChosen: true,
      selfImprovement: "off",
      selfImprovementChosen: false,
      projectRoots: [],
    });
    await expect(saveWorkerSkills(home, [])).rejects.toThrow("already lists workerSkills");

    await writeFile(join(home, "settings.toml"), "# mine\n");
    expect(await saveWorkerSkills(home, [])).toEqual({
      workerSkills: [],
      workerSkillsChosen: true,
      selfImprovement: "off",
      selfImprovementChosen: false,
      projectRoots: [],
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

test("code folders and the self-improvement mode are saved, replacing a one-line value", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-settings-"));
  try {
    await saveProjectRoots(home, ["/Users/me/code"]);
    await saveSelfImprovement(home, "report");
    await saveProjectRoots(home, ["/Users/me/code", "/Users/me/work"]);
    const settings = await readHomeSettings(home);
    expect(settings.projectRoots).toEqual(["/Users/me/code", "/Users/me/work"]);
    expect(settings.selfImprovement).toBe("report");
    expect(settings.selfImprovementChosen).toBe(true);
    await expect(saveProjectRoots(home, ["code"])).rejects.toThrow("absolute path");

    await writeFile(join(home, "settings.toml"), 'projectRoots = [\n  "/a",\n]\n');
    await expect(saveProjectRoots(home, ["/b"])).rejects.toThrow("over several lines");
    expect(await readFile(join(home, "settings.toml"), "utf8")).toBe(
      'projectRoots = [\n  "/a",\n]\n',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
