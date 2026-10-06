import { expect } from "bun:test";
import type { Screen, TernParityHost } from "./harness.ts";
import { withParity } from "./inventory.ts";

export type KnownDivergence = Readonly<{ name: string; run: () => Promise<void> }>;

function toasts(host: TernParityHost, mark: number): readonly string[] {
  return host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`);
}

/** Each task row the user clicks next opens its own task page with no toast. */
async function expectOpensWork(
  host: TernParityHost,
  panel: Screen,
  rows: readonly (readonly [RegExp, string])[],
): Promise<void> {
  for (const [row, title] of rows) {
    const mark = host.events.length;
    await panel.click(row);
    expect(toasts(host, mark)).toEqual([]);
    expect((await host.screen(host.pane("task")).render()).title).toBe(title);
  }
}

/**
 * Finding 1 in the Tern architecture review: a staged open that failed in Luau without
 * changing anything, or a browser open whose reply was lost, used to pause every later native
 * open for that coordinator. Step 5 settles both, so the next open succeeds. A route Tern never
 * delivered stays quarantined by design, so the inventory's Generic row drives it instead.
 */
export const knownDivergence: readonly KnownDivergence[] = [
  {
    name: "a Luau failure that changed nothing settles, and later opens work",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click(/^● Port the terminal/);
        await host.fault("newBlock", true);
        let mark = host.events.length;
        await panel.click(/^● Fix login/);
        const failed = host.toasts(mark);
        expect(failed.map((toast) => toast.title)).toEqual([
          "Tandem view did not open",
          "Tandem couldn't run that action",
        ]);
        expect(failed[0]?.message).toEndWith("Native block could not open");
        expect(failed[1]?.message).toBe(
          "The Tandem view did not open and nothing changed. Open it again.",
        );
        await host.fault("newBlock", false);
        await expectOpensWork(host, panel, [
          [/^● Write docs/, "Write docs"],
          [/^● Fix login/, "Fix login"],
        ]);
        const task = host.screen(host.pane("task"));
        mark = host.events.length;
        await task.click("← Orchestrator");
        expect(toasts(host, mark)).toEqual([]);
      }),
  },
  {
    name: "a browser open whose reply is lost is reported once, and later opens work",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click("▦");
        const board = host.screen(host.pane("board"));
        host.loseBrowserReplies = true;
        const mark = host.events.length;
        await board.click("#281 open ↗");
        expect(toasts(host, mark)).toEqual([
          "Tandem couldn't run that action: Tern did not confirm the PR opened in its browser. Tandem did not retry; open it again if it is missing.",
        ]);
        expect(
          host.world.ternBlocks().flatMap((block) => (block.browserUrl ? [block.browserUrl] : [])),
        ).toEqual(["https://github.com/acme/app/pull/281"]);
        host.loseBrowserReplies = false;
        await expectOpensWork(host, panel, [
          [/^● Write docs/, "Write docs"],
          [/^● Port the terminal/, "Port the terminal"],
        ]);
      }),
  },
];
