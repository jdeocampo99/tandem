import { expect } from "bun:test";
import type { TernParityHost } from "./harness.ts";
import { withParity } from "./inventory.ts";

export type KnownDivergence = Readonly<{ name: string; run: () => Promise<void> }>;

const UNKNOWN = "tandem: tern open outcome is unknown; quarantine and keep resources\n";
const PAUSED = "tandem: tern open recovery outcome is unknown; quarantine and keep resources\n";

function toasts(host: TernParityHost, mark: number): readonly string[] {
  return host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`);
}

/**
 * Finding 1 in the Tern architecture review: after a staged open fails in Luau or never
 * writes its receipt, every later native open for that coordinator stays paused. These
 * cases record that bug as today's behavior; step 5 flips them so the second open succeeds.
 */
export const knownDivergence: readonly KnownDivergence[] = [
  {
    name: "a Luau failure during a staged open pauses every later open",
    run: () =>
      withParity(async ({ host, panel }) => {
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
        for (const row of [/^● Write docs/, /^● Port the terminal/]) {
          mark = host.events.length;
          await panel.click(row);
          expect(toasts(host, mark)).toEqual([`Tandem couldn't run that action: ${PAUSED}`]);
          expect(host.world.ternBlocks().map((block) => block.program)).not.toContain(
            "tandem.task",
          );
        }
      }),
  },
  {
    name: "a staged open whose receipt never arrives pauses every later open",
    run: () =>
      withParity(async ({ host, panel }) => {
        host.dropRoutes = true;
        let mark = host.events.length;
        await panel.click(/^● Fix login/);
        expect(toasts(host, mark)).toEqual([`Tandem couldn't run that action: ${UNKNOWN}`]);
        host.dropRoutes = false;
        for (const row of [/^● Write docs/, /^● Port the terminal/]) {
          mark = host.events.length;
          await panel.click(row);
          expect(toasts(host, mark)).toEqual([`Tandem couldn't run that action: ${PAUSED}`]);
          expect(host.world.ternBlocks().map((block) => block.program)).not.toContain(
            "tandem.task",
          );
        }
      }),
  },
];
