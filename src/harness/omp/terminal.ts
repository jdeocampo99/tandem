import { TERMINAL } from "@oh-my-pi/pi-tui";

/** Whether this terminal opens OSC 8 hyperlinks, by OMP's own detection. */
export function terminalOpensLinks(): boolean {
  return TERMINAL.hyperlinks;
}
