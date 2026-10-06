import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryKey } from "../../src/config/repositories.ts";
import { dismissNativeCatchUp, visitNativeProject } from "../../src/memory/native-visits.ts";

test("returning after an hour shows changed work once; short visits and dismissed work stay quiet", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const input = {
    home,
    project: "/fixture/tandem",
    signature: "before",
    now: "2030-01-02T10:00:00Z",
  };
  let opened = 0;
  const show = async () => {
    opened++;
  };
  try {
    expect(await visitNativeProject(input, show)).toBe(false);
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T10:30:00Z", signature: "changed-early" },
        show,
      ),
    ).toBe(false);
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T11:30:00Z", signature: "changed-later" },
        show,
      ),
    ).toBe(true);
    await dismissNativeCatchUp({
      ...input,
      now: "2030-01-02T11:31:00Z",
      signature: "changed-later",
    });
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T13:00:00Z", signature: "changed-later" },
        show,
      ),
    ).toBe(false);
    expect(opened).toBe(1);
    const saved = JSON.parse(
      await readFile(join(home, "native-visits", `${repositoryKey(input.project)}.json`), "utf8"),
    );
    expect(saved.previousSignature).toBe("changed-later");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed catch-up open does not acknowledge its changed signature", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const input = {
    home,
    project: "/fixture/tandem",
    signature: "before",
    now: "2030-01-02T10:00:00Z",
  };
  try {
    await visitNativeProject(input, async () => {});
    const later = { ...input, now: "2030-01-02T11:00:00Z", signature: "after" };
    await expect(
      visitNativeProject(later, async () => {
        throw new Error("unknown open outcome");
      }),
    ).rejects.toThrow("unknown open outcome");
    const saved = JSON.parse(
      await readFile(join(home, "native-visits", `${repositoryKey(input.project)}.json`), "utf8"),
    );
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe(input.now);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
