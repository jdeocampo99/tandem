import { expect, test } from "bun:test";
import {
  processArguments,
  readForegroundGroup,
} from "../../../src/terminal-backend/tern/process-reader.ts";

test("native argv decoding retains argument boundaries and ignores everything after argc arguments", () => {
  const tail = new TextEncoder().encode(
    "/bin/program\0\0program\0an argument with spaces\0\0ignored trailing bytes\0",
  );
  const bytes = new Uint8Array(4 + tail.length);
  new DataView(bytes.buffer).setInt32(0, 3, true);
  bytes.set(tail, 4);
  expect(processArguments(bytes)).toEqual(["program", "an argument with spaces", ""]);
});

/** A job-control shell gives its background job a process group of its own. */
async function withJobGroup(job: string, body: (group: number) => Promise<void>) {
  const shell = Bun.spawn(["/bin/sh", "-c", `set -m; ${job} & wait`], {
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
    await body(group);
  } finally {
    if (group !== undefined) process.kill(-group, "SIGKILL");
    shell.kill();
  }
}

test.if(process.platform === "darwin")(
  "the foreground proof reports each live member's exact argv",
  async () => {
    await withJobGroup("/bin/sleep 30", async (group) => {
      const members = await readForegroundGroup(group);
      expect(members.map((member) => ({ name: member.name, argv: member.argv }))).toEqual([
        { name: "sleep", argv: ["/bin/sleep", "30"] },
      ]);
    });
  },
  30_000,
);

test.if(process.platform === "darwin")(
  "the foreground proof ignores group members that exit while it reads them",
  async () => {
    // The loop's short-lived children churn while the proof lists and reads the group.
    await withJobGroup("(while :; do /usr/bin/true; done)", async (group) => {
      const failed: string[] = [];
      for (let read = 0; read < 20; read += 1) {
        try {
          await readForegroundGroup(group);
        } catch (error) {
          failed.push(String(error));
        }
      }
      expect(failed).toEqual([]);
    });
  },
  30_000,
);

test("the foreground proof refuses a group id that is not a positive integer", async () => {
  for (const group of [0, -1, 1.5, Number.NaN])
    await expect(readForegroundGroup(group)).rejects.toThrow();
});
