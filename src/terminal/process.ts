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
