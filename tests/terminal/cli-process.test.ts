import { expect, test } from "bun:test";

const modulePath = new URL("../../src/terminal/cli-process.ts", import.meta.url).pathname;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the launcher exits while the persistent process it started keeps running", async () => {
  const script = [
    `const { defaultStartPersistent } = await import(${JSON.stringify(modulePath)});`,
    `const started = await defaultStartPersistent({ argv: ["sleep", "30"], cwd: ${JSON.stringify(process.cwd())} });`,
    "console.log(started?.pid ?? 0);",
  ].join("\n");
  const launcher = Bun.spawn({
    cmd: ["bun", "-e", script],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const outcome = await Promise.race([
    launcher.exited,
    Bun.sleep(5000).then(() => "launcher still running after 5s" as const),
  ]);
  if (outcome !== 0) launcher.kill();
  const childPid = Number((await new Response(launcher.stdout).text()).trim());
  try {
    expect(outcome).toBe(0);
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);
  } finally {
    if (childPid > 0) process.kill(childPid, "SIGTERM");
  }
});
