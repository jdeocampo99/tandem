// The real Tandem CLI behind the plugin's tandem.sh in workflows-native.test.ts.
// Tern commands reach the test's isolated daemon and every other program is refused. Each
// coordinator pane runs a stand-in shell, so its inspection reports the recorded harness process.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/contracts.ts";
import { discoverCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { runTerminal } from "../../../src/main.ts";
import { terminalBackend } from "../../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../../src/terminal-backend/contract.ts";
import { isolatedRunner, setupRunner } from "./native-window.ts";

const root = process.env.TANDEM_WORKFLOW_ROOT;
if (process.env.TANDEM_HOME === undefined || !root?.startsWith("/private/tmp/tdm-"))
  throw new Error("Isolated workflow root required");
const home: string = process.env.TANDEM_HOME;
const log = join(root, "driver.log");

const spawn: CommandRunner = async (request) => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdout: "pipe",
    stderr: "pipe",
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};
const run = setupRunner(isolatedRunner(spawn, log), log);
const records = (await discoverCoordinatorRecords({ home })).records.map((entry) => entry.record);
const base = terminalBackend(run, { terminal: "tern", home });
const terminal: TerminalBackend = {
  ...base,
  inspect: async (target) => {
    const result = await base.inspect(target);
    const record = records.find((entry) => entry.endpoint.paneId === target.endpoint.paneId);
    if (record === undefined) return result;
    return {
      ...result,
      activeWorker: true,
      processInfo: {
        ...result.processInfo,
        foregroundProcesses: [
          { pid: 1, name: "omp", argv: record.command, argv0: "omp", commandLine: undefined },
        ],
      },
    };
  },
};

async function tandem(argv: readonly string[]): Promise<number> {
  const output: string[] = [];
  const outcome = await runTerminal(argv, {
    cwd: records[0]?.repoPath ?? home,
    processEnvironment: process.env,
    run,
    terminal,
    stdout: (text) => {
      output.push(text);
      process.stdout.write(text);
    },
    stderr: (text) => {
      output.push(text);
      process.stderr.write(text);
    },
  });
  await appendFile(
    log,
    `${JSON.stringify({ argv, exitCode: outcome.exitCode, output: output.join("") })}\n`,
  );
  return outcome.exitCode;
}

// `native act` reads its action envelope from this process's stdin, as from Tern.
process.exit(await tandem(process.argv.slice(2)));
