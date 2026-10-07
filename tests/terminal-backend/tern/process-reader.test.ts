import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { processArguments } from "../../../src/terminal-backend/tern/process-reader.ts";

test("native argv decoding retains argument boundaries and ignores everything after argc arguments", () => {
  const tail = new TextEncoder().encode(
    "/bin/program\0\0program\0an argument with spaces\0\0ignored trailing bytes\0",
  );
  const bytes = new Uint8Array(4 + tail.length);
  new DataView(bytes.buffer).setInt32(0, 3, true);
  bytes.set(tail, 4);
  expect(processArguments(bytes)).toEqual(["program", "an argument with spaces", ""]);
});

test.if(process.platform === "darwin")(
  "the foreground proof ignores group members that exit while it reads them",
  async () => {
    const reader = fileURLToPath(
      new URL("../../../src/terminal-backend/tern/process-reader.ts", import.meta.url),
    );
    // A job-control shell gives the loop its own process group, which churns short-lived children.
    const shell = Bun.spawn(["/bin/sh", "-c", "set -m; (while :; do /usr/bin/true; done) & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let group: number | undefined;
    try {
      while (group === undefined) {
        await Bun.sleep(50);
        group = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid=,ppid="])
          .stdout.toString()
          .split("\n")
          .map((line) => line.trim().split(/\s+/u).map(Number))
          .find(([, , ppid]) => ppid === shell.pid)?.[1];
      }
      const failed = Array.from({ length: 20 }, () =>
        Bun.spawnSync([process.execPath, reader, String(group)], { stderr: "pipe" }),
      ).filter((run) => run.exitCode !== 0);
      expect(failed.map((run) => run.stderr.toString())).toEqual([]);
    } finally {
      if (group !== undefined) process.kill(-group, "SIGKILL");
      shell.kill();
    }
  },
  30_000,
);
