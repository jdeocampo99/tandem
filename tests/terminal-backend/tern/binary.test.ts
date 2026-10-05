import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { TERN_BINARY } from "../../../src/terminal-backend/tern/protocol.ts";

test("Tern uses the PATH installation, app fallback, or explicitly injected binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tandem-tern-path-"));
  const run = async () => ({ code: 0, stdout: "tern 0.4.5", stderr: "" });
  const target = "test";
  try {
    expect(ternBackend(run, { environment: { PATH: directory } }).clientCommand(target)).toEqual([
      TERN_BINARY,
    ]);
    const executable = join(directory, "tern");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const terminal = ternBackend(run, { environment: { PATH: directory } });
    expect(terminal.clientCommand(target)).toEqual([executable]);
    expect(terminal.serverCommand(target)).toEqual([executable, "daemon"]);
    expect(
      ternBackend(run, { binary: "fake-tern", environment: { PATH: directory } }).clientCommand(
        target,
      ),
    ).toEqual(["fake-tern"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
