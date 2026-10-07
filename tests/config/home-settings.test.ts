import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHomeSettings,
  readHomeSettingsSync,
  saveProjectRoots,
  saveSelfImprovement,
} from "../../src/config/home-settings.ts";

test("legacy worker skills settings are accepted but ignored", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-settings-"));
  try {
    await writeFile(
      join(home, "settings.toml"),
      'workerSkills = ["old"]\nselfImprovement = "report"\nprojectRoots = ["/code"]\n',
    );
    expect(await readHomeSettings(home)).toEqual({
      selfImprovement: "report",
      selfImprovementChosen: true,
      projectRoots: ["/code"],
    });
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

test("the terminal setting is read beside existing home settings and validated", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-home-terminal-"));
  try {
    await writeFile(join(home, "settings.toml"), 'selfImprovement = "report"\nterminal = "tern"\n');
    expect(readHomeSettingsSync(home).terminal).toBe("tern");
    expect((await readHomeSettings(home)).selfImprovement).toBe("report");
    await writeFile(join(home, "settings.toml"), 'terminal = "another"\n');
    expect(() => readHomeSettingsSync(home)).toThrow('terminal must be "herdr" or "tern"');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
