import { expect, test } from "bun:test";
import type { CommandResult } from "../../src/contracts.ts";
import { resolveCoordinatorSourceHead } from "../../src/coordinator/source.ts";

test("coordinator source HEAD failures keep their plain errors and exact text", async () => {
  const cases: readonly Readonly<{ result: CommandResult; message: string }>[] = [
    {
      result: { code: 7, stdout: " fallback\n", stderr: " denied\n" },
      message: "git local source HEAD failed with exit code 7: denied",
    },
    {
      result: { code: 7, stdout: "", stderr: "" },
      message: "git local source HEAD failed with exit code 7",
    },
    {
      result: { code: 0, stdout: " \n", stderr: "" },
      message: "git local source HEAD returned no value",
    },
  ];
  for (const entry of cases) {
    const error = await resolveCoordinatorSourceHead(
      async (request) =>
        request.argv.includes("remote") ? { code: 0, stdout: "", stderr: "" } : entry.result,
      "/tmp/repo",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected source failure");
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe(entry.message);
  }
});
