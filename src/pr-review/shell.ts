/**
 * Decides whether a PR reviewer's bash command only reads. A reviewer may look at history and at
 * GitHub, never change either, so anything this cannot prove read-only is refused.
 */

/** Subcommands that only read the repository. */
const GIT_READS: ReadonlySet<string> = new Set([
  "log",
  "show",
  "diff",
  "blame",
  "grep",
  "status",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
  "shortlog",
  "describe",
  "rev-list",
  "name-rev",
]);

/** `gh <group> <verb>` pairs that only read. */
const GH_READS: ReadonlySet<string> = new Set([
  "pr view",
  "pr diff",
  "pr checks",
  "issue view",
  "repo view",
  "run view",
  "run list",
]);

/** Options that make an otherwise read-only git command run programs or write files. */
const GIT_UNSAFE_ARGUMENT =
  /^(?:-c|--config-env|--exec-path|--output|--ext-diff|--textconv|--open-files-in-pager|-O)(?:=|$)/;

/** `gh api` options that send data, and so turn a GET into a write. */
const GH_API_WRITE_ARGUMENT = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/;

const SHELL_SYNTAX = /[;&|`$<>(){}\\\n\r]/;

/** Undefined when the command only reads; otherwise the reason it is refused. */
export function readOnlyCommandRefusal(command: string): string | undefined {
  if (SHELL_SYNTAX.test(command)) {
    return "use one plain git or gh command, without pipes, redirects, substitutions, or chaining";
  }
  const words = splitWords(command);
  if (words === undefined) return "the command has an unclosed quote";
  const [program, ...args] = words;
  if (program === "git") return gitRefusal(args);
  if (program === "gh") return ghRefusal(args);
  return "only read-only git and gh commands are available; use read, grep, and glob for files";
}

function gitRefusal(args: readonly string[]): string | undefined {
  if (args.some((arg) => GIT_UNSAFE_ARGUMENT.test(arg))) {
    return "that git option can run programs or write files";
  }
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand === undefined || !GIT_READS.has(subcommand)) {
    return `git ${subcommand ?? ""} is not a read-only command here; allowed: ${[...GIT_READS].join(", ")}`;
  }
  return undefined;
}

function ghRefusal(args: readonly string[]): string | undefined {
  const [group, verb] = args;
  if (group === "api") {
    const method = methodOf(args);
    if (method !== undefined && method.toUpperCase() !== "GET") return "gh api may only GET";
    if (args.some((arg) => GH_API_WRITE_ARGUMENT.test(arg))) {
      return "gh api fields send data; put query parameters in the path instead";
    }
    return undefined;
  }
  if (group !== undefined && verb !== undefined && GH_READS.has(`${group} ${verb}`)) {
    if (args.includes("--web") || args.includes("-w")) return "opening a browser is not available";
    return undefined;
  }
  return `gh ${group ?? ""} ${verb ?? ""} is not a read-only command here; allowed: gh api (GET), ${[...GH_READS].map((pair) => `gh ${pair}`).join(", ")}`;
}

function methodOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-X" || arg === "--method") return args[index + 1] ?? "";
    const inline = /^(?:-X|--method=)(.+)$/.exec(arg);
    if (inline !== null) return inline[1];
  }
  return undefined;
}

/** Splits on whitespace, honoring single and double quotes; undefined on an unclosed quote. */
function splitWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of command.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(current);
  return words;
}
