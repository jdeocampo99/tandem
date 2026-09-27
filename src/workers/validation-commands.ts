/**
 * Keeps an implementer from running the task's pinned validation commands itself: the validation
 * worker runs them after the report, so running them first only repeats that work.
 */
import type { ValidationCommand } from "../contracts.ts";

export const VALIDATION_COMMAND_REFUSAL =
  "Tandem runs these checks after you submit; don't run them yourself. A focused command, such as one test file, is fine.";

const SHELL = "/bin/sh";

/** The command line a person would type for a pinned validation command. */
export function validationCommandLine(command: ValidationCommand): string {
  const [program, flag, script] = command.argv;
  return program === SHELL && flag === "-c" && script !== undefined && command.argv.length === 3
    ? script
    : command.argv.join(" ");
}

/**
 * Why a shell command is refused: it runs one of `validationCommands` as written, alone or
 * chained with other commands. Environment prefixes and output redirects do not change that;
 * extra arguments, such as a single test file, do.
 */
export function validationCommandRefusal(
  validationCommands: readonly string[],
  command: string,
): string | undefined {
  const segments = commandSegments(command);
  const runsOne = validationCommands.some((validation) =>
    containsRun(segments, commandSegments(validation)),
  );
  return runsOne ? VALIDATION_COMMAND_REFUSAL : undefined;
}

/** Whether `needle` appears as consecutive segments of `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((segment, offset) => haystack[start + offset] === segment)) return true;
  }
  return false;
}

/** Each simple command in a shell line, as its program and arguments joined by one space. */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => essentialWords(segment.trim().split(/\s+/)).join(" "))
    .filter((segment) => segment.length > 0);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^(?:\d*|&)(?:>>?|<)/;
const BARE_REDIRECT = /^(?:\d*|&)(?:>>?|<)$/;

/** Drops leading `VAR=value` and `env` options, and every output redirect with its target. */
function essentialWords(words: readonly string[]): string[] {
  let start = 0;
  while (start < words.length) {
    const word = words[start] ?? "";
    if (ASSIGNMENT.test(word)) start += 1;
    else if (word === "env") {
      start += 1;
      while ((words[start] ?? "").startsWith("-")) start += words[start] === "-u" ? 2 : 1;
    } else break;
  }
  const kept: string[] = [];
  for (let index = start; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (BARE_REDIRECT.test(word)) index += 1;
    else if (!REDIRECT.test(word) && word.length > 0) kept.push(word);
  }
  return kept;
}
