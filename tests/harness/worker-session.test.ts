import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyMockupAsset } from "../../src/harness/worker-session.ts";

test("copy_asset copies a checkout file byte for byte and refuses anything outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-copy-asset-"));
  try {
    const cwd = join(root, "worktree");
    const artifactDir = join(root, "presentation");
    await mkdir(join(cwd, "public"), { recursive: true });
    await mkdir(artifactDir);
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
    await writeFile(join(cwd, "public", "jr.webp"), bytes);
    const target = await copyMockupAsset({
      cwd,
      artifactDir,
      from: "public/jr.webp",
      name: "jr.webp",
    });
    expect(target).toBe(join(artifactDir, "jr.webp"));
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);

    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(cwd, "public", "link.txt"));
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "../secret.txt", name: "secret.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/link.txt", name: "link.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/jr.webp", name: "../jr.webp" }),
    ).rejects.toThrow("plain file name");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public", name: "dir" }),
    ).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
