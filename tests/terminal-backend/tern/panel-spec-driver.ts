// Native fixture boundary: real pane/session inspection and focus, synthetic coordinator process.
// Invoked only by the private copy of tandem.sh in panel-spec-native.test.ts.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { nativeAlertCounts } from "../../../src/board/native-alerts.ts";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { runTerminal } from "../../../src/main.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";

const home = process.env.TANDEM_HOME;
if (!home?.startsWith("/private/tmp/tdm-panel-spec-"))
  throw new Error("Isolated fixture home required");
const run: CommandRunner = async (request) => {
  const process = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    ...(request.env === undefined ? {} : { env: request.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, code };
};
const records = await listCoordinatorRecords(home, "fixture");
const base = ternBackend(run, { home });
const terminal = {
  ...base,
  inspect: async (target: Parameters<typeof base.inspect>[0]) => {
    const result = await base.inspect(target);
    const record = records.find((record) => record.endpoint.paneId === target.endpoint.paneId);
    if (!record) return result;
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
await writeFile(join(home, "actions.log"), `${process.argv.slice(2).join("\n")}\n`, { flag: "a" });
const outcome = await runTerminal(process.argv.slice(2), {
  cwd: records[0]?.repoPath ?? home,
  processEnvironment: process.env,
  run,
  terminal,
});
for (const record of records) {
  const path = nativeViewsPath(home, record.repoPath);
  const envelope = z
    .object({ model: z.record(z.unknown()) })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const panel = z
    .object({ header: z.record(z.unknown()) })
    .passthrough()
    .parse(envelope.model.panel);
  const count = await nativeAlertCounts(home, record.repoPath);
  await writeFile(
    path,
    nativeViewText("panel", {
      ...envelope.model,
      writtenAt: new Date().toISOString(),
      panel: { ...panel, header: { ...panel.header, bellCount: count.unread } },
    }),
  );
}
process.exit(outcome.exitCode);
