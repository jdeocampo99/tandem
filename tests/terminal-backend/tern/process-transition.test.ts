import { expect, test } from "bun:test";
import type { CommandRunner } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { withScenario } from "../../evals/scenario.ts";

for (const mode of [
  "exec",
  "group-change",
  "stable-disagreement",
  "churn",
  "foreign-pane",
] as const) {
  test(`foreground proof ${mode} requires matching fresh native evidence`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const endpoint = world.openPane({ paneId: "2001", cwd: world.repoPath });
      let nativeReads = 0;
      const run: CommandRunner = async (request) => {
        if (request.argv[1]?.endsWith("process-reader.ts")) {
          nativeReads++;
          if (mode === "group-change" && nativeReads === 1)
            world.replaceForeground(endpoint.paneId, ["omp", "--session-dir", "new"]);
          const actual = await world.run(request);
          if (
            mode !== "foreign-pane" &&
            (mode === "stable-disagreement" || mode === "churn" || nativeReads === 1)
          )
            return {
              ...actual,
              stdout:
                mode === "group-change"
                  ? "[]"
                  : actual.stdout.replace(
                      '"argv":["sh"]',
                      `"argv":["env-${mode === "churn" ? nativeReads : 1}"]`,
                    ),
            };
          if (mode === "exec" && nativeReads > 1)
            return {
              ...actual,
              stdout: actual.stdout.replace('"argv":["sh"]', '"argv":["env-1"]'),
            };
          return actual;
        }
        const actual = await world.run(request);
        if (request.argv[1] === "process" && nativeReads > 0) {
          if (mode === "foreign-pane")
            return { ...actual, stdout: actual.stdout.replace('"pane":"2001"', '"pane":"2002"') };
          if (mode === "exec" || mode === "churn")
            return {
              ...actual,
              stdout: actual.stdout.replaceAll('"argv":["sh"]', `"argv":["env-${nativeReads}"]`),
            };
        }
        return actual;
      };
      const terminal = ternBackend(run);
      if (mode === "exec" || mode === "group-change") {
        expect(
          (await terminal.inspect({ endpoint, cwd: world.repoPath })).processInfo
            .foregroundProcesses[0]?.argv[0],
        ).toBe(mode === "exec" ? "env-1" : "omp");
        expect(nativeReads).toBe(2);
      } else {
        await expect(terminal.closeOwned({ endpoint, cwd: world.repoPath })).rejects.toThrow();
        expect(world.trace().filter((event) => event.action === "tern close")).toHaveLength(0);
        expect(nativeReads).toBe(mode === "churn" ? 3 : 1);
      }
    });
  });
}
