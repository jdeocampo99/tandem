import { expect } from "bun:test";
import type { Screen, TernParityHost } from "./harness.ts";
import { withParity } from "./inventory.ts";

export type KnownDivergence = Readonly<{ name: string; run: () => Promise<void> }>;

const UNKNOWN = "tern open outcome is unknown; quarantine and keep resources";
const PAUSED = "tern open recovery outcome is unknown; quarantine and keep resources";

function toasts(host: TernParityHost, mark: number): readonly string[] {
  return host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`);
}

/** Each task row the user clicks next is refused with `refusal`, and no task page opens. */
async function expectOpensPaused(
  host: TernParityHost,
  panel: Screen,
  rows: readonly RegExp[],
  refusal: string,
): Promise<void> {
  const pages = host.world.ternBlocks().filter((block) => block.program === "tandem.task").length;
  for (const row of rows) {
    const mark = host.events.length;
    await panel.click(row);
    expect(toasts(host, mark)).toEqual([`Tandem couldn't run that action: ${refusal}`]);
    expect(host.world.ternBlocks().filter((block) => block.program === "tandem.task")).toHaveLength(
      pages,
    );
  }
}

/**
 * Finding 1 in the Tern architecture review: after a staged open fails in Luau without
 * changing anything, or opens a browser whose reply is lost, every later native open for that
 * coordinator stays paused. These cases record that bug as today's behavior; step 5 flips them
 * so the next open succeeds. A route Tern never delivered stays quarantined by design, so the
 * inventory's Generic row drives it instead.
 */
export const knownDivergence: readonly KnownDivergence[] = [
  {
    name: "a Luau failure that changed nothing pauses every later open",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click(/^● Port the terminal/);
        const task = host.screen(host.pane("task"));
        await host.fault("newBlock", true);
        let mark = host.events.length;
        await panel.click(/^● Fix login/);
        const failed = host.toasts(mark);
        expect(failed.map((toast) => toast.title)).toEqual([
          "Tandem view did not open",
          "Tandem couldn't run that action",
        ]);
        expect(failed[0]?.message).toEndWith("Native block could not open");
        expect(failed[1]?.message).toBe(UNKNOWN);
        await host.fault("newBlock", false);
        await expectOpensPaused(host, panel, [/^● Write docs/, /^● Fix login/], PAUSED);
        mark = host.events.length;
        await task.click("← Orchestrator");
        expect(toasts(host, mark)).toEqual([
          "Tandem kept an uncertain view: Returned to your conversation. An earlier view could not be verified, so its views and recovery record were kept. Continue here or use Tern's tab switcher; opening new native views stays paused until exact recovery evidence is available.",
        ]);
      }),
  },
  {
    name: "a browser open whose reply is lost pauses every later open",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click("▦");
        const board = host.screen(host.pane("board"));
        host.loseBrowserReplies = true;
        const mark = host.events.length;
        await board.click("#281 open ↗");
        expect(toasts(host, mark)).toEqual([
          "Tandem couldn't run that action: tern browser outcome is unknown; quarantine and keep resources",
        ]);
        expect(
          host.world.ternBlocks().flatMap((block) => (block.browserUrl ? [block.browserUrl] : [])),
        ).toEqual(["https://github.com/acme/app/pull/281"]);
        host.loseBrowserReplies = false;
        await expectOpensPaused(
          host,
          panel,
          [/^● Write docs/, /^● Port the terminal/],
          "tern open intent outcome is unknown; quarantine and keep resources",
        );
      }),
  },
];
