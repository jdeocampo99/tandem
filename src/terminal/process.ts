import { createInterface, type Interface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import search from "@inquirer/search";
import select from "@inquirer/select";
import type { TerminalPrompter } from "./onboarding.ts";

export type ReadlineResources = Readonly<{
  readonly prompter: TerminalPrompter;
  readonly close: () => void;
}>;

export function streamIsTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { readonly isTTY?: unknown }).isTTY === true;
}

/** Esc, q, or Ctrl-C closes a live view. Keys that start with Esc, like arrows, do not. */
export function isCloseKey(chunk: string): boolean {
  return chunk === "\x1b" || chunk === "q" || chunk === "Q" || chunk === "\x03";
}

/**
 * Reads single keys from a terminal until one closes the view, then gives the terminal back.
 * `release` gives it back early, as when the view stops on an error. Without a terminal `closed`
 * never settles, and Ctrl-C stops the process as usual.
 */
export function watchCloseKeys(input: NodeJS.ReadableStream): Readonly<{
  readonly closed: Promise<void>;
  readonly release: () => void;
}> {
  const tty = input as NodeJS.ReadableStream & {
    readonly isTTY?: unknown;
    readonly setRawMode?: (raw: boolean) => unknown;
  };
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    return {
      closed: new Promise<void>(() => {
        // Without a TTY no close key can arrive, so this never settles.
      }),
      release: () => {
        // Nothing was taken over.
      },
    };
  }
  const setRawMode = tty.setRawMode.bind(tty);
  let release = (): void => {
    // Replaced once the listener is installed.
  };
  const closed = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      if (!isCloseKey(chunk.toString())) return;
      release();
      resolve();
    };
    release = () => {
      release = () => {
        // Already released.
      };
      input.off("data", onData);
      setRawMode(false);
      input.pause();
    };
    setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
  return { closed, release: () => release() };
}

export function writeText(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}

export function createReadlineResources(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReadlineResources {
  let readline: Interface | undefined;
  const controller = new AbortController();
  const closeReadline = (): void => {
    readline?.close();
    readline = undefined;
  };
  const ensureReadline = (): Interface => {
    if (readline === undefined) readline = createInterface({ input, output });
    return readline;
  };
  return {
    prompter: {
      ask: async (question, selection) => {
        if (selection === undefined) return ensureReadline().question(question);
        closeReadline();
        // Inquirer ends its output after each prompt; the caller still owns our output stream.
        const promptOutput = new PassThrough();
        for (const key of ["columns", "rows", "isTTY"] as const) {
          Object.defineProperty(promptOutput, key, { get: () => Reflect.get(output, key) });
        }
        promptOutput.pipe(output, { end: false });
        const context = { input, output: promptOutput, signal: controller.signal };
        const config = {
          message: question,
          ...(selection.default === undefined ? {} : { default: selection.default }),
        };
        try {
          if (!selection.search) {
            return await select({ ...config, choices: selection.choices }, context);
          }
          const indexed = selection.choices.map((choice) => ({
            choice,
            text: `${choice.name} ${choice.value}`.toLowerCase(),
          }));
          return await search(
            {
              ...config,
              source: async (term) => {
                const query = term?.trim().toLowerCase() ?? "";
                if (query.length === 0) return selection.choices;
                const matches: (typeof selection.choices)[number][] = [];
                for (const entry of indexed) {
                  if (entry.text.includes(query)) matches.push(entry.choice);
                }
                return matches;
              },
            },
            context,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "ExitPromptError" ||
              (error.name === "AbortPromptError" && controller.signal.aborted))
          ) {
            return "cancel";
          }
          throw error;
        } finally {
          promptOutput.end();
        }
      },
      write: (text) => writeText(output, text),
    },
    close: () => {
      controller.abort();
      closeReadline();
    },
  };
}
