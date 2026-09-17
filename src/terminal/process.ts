import { createInterface, type Interface } from "node:readline/promises";
import type { TerminalPrompter } from "./onboarding.ts";

export type ReadlineResources = Readonly<{
  readonly prompter: TerminalPrompter;
  readonly close: () => void;
}>;

export function streamIsTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { readonly isTTY?: unknown }).isTTY === true;
}

export function writeText(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}

export function createReadlineResources(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReadlineResources {
  let readline: Interface | undefined;
  const ensureReadline = (): Interface => {
    if (readline === undefined) readline = createInterface({ input, output });
    return readline;
  };
  return {
    prompter: {
      ask: (question) => ensureReadline().question(question),
      write: (text) => writeText(output, text),
    },
    close: () => {
      readline?.close();
      readline = undefined;
    },
  };
}
