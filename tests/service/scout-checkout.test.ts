import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeScoutCheckout } from "../../src/service/scout-checkout.ts";

test("scout checkout reads preserve empty fields and the sequential command order", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "tandem-scout-checkout-"));
  try {
    const commands: string[] = [];
    const value = await observeScoutCheckout(async (request) => {
      commands.push(request.argv.slice(3).join(" "));
      return {
        code: 0,
        stdout: request.argv.includes("rev-parse") ? " head-1\n" : " \n",
        stderr: "",
      };
    }, checkout);
    expect(value).toEqual({
      status: "observed",
      head: "head-1",
      branch: "",
      dirty: false,
      unmerged: false,
    });
    expect(commands).toEqual([
      "rev-parse HEAD",
      "branch --show-current",
      "status --porcelain=v1 --untracked-files=all",
      "diff --name-only --diff-filter=U",
    ]);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("scout checkout observations preserve git failure and missing HEAD details", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "tandem-scout-checkout-"));
  try {
    expect(
      await observeScoutCheckout(
        async () => ({ code: 7, stdout: " fallback\n", stderr: " denied\n" }),
        checkout,
      ),
    ).toEqual({ status: "unreadable", detail: "git scout HEAD failed with exit code 7: denied" });
    expect(
      await observeScoutCheckout(async () => ({ code: 0, stdout: " \n", stderr: "" }), checkout),
    ).toEqual({ status: "unreadable", detail: "git reported no HEAD commit" });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
