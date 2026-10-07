import type { CreateTaskRequest } from "../service/controller.ts";
import { FALLBACK_SPECIALIST } from "./built-in.ts";

/**
 * The implementation task that proposes one Just-me specialist to a repository's team. The file's
 * text goes into the objective inside a fence longer than any backtick run in it, and the criteria
 * pin it byte for byte, so the worker copies it rather than rewriting it.
 */
export function teamSpecialistTask(
  input: Readonly<{
    projectRepoPath: string;
    name: string;
    text: string;
    /** `project`: the coordinator's own repository; otherwise another registered checkout. */
    target: "project" | Readonly<{ path: string; repo: string }>;
  }>,
): CreateTaskRequest {
  const file = `.tandem/specialists/${input.name}.md`;
  const longest = Math.max(0, ...[...input.text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const where = input.target === "project" ? "this repository" : input.target.repo;
  return {
    repoPath: input.projectRepoPath,
    kind: "implementation",
    title: `share ${input.name} specialist`,
    objective: [
      `Add the specialist file ${file} to ${where} so the team can use the user's ${input.name} specialist.`,
      "Create the file with exactly this content, byte for byte, and change nothing else:",
      "",
      `${fence}markdown`,
      `${input.text.endsWith("\n") ? input.text : `${input.text}\n`}${fence}`,
    ].join("\n"),
    acceptanceCriteria: [
      `\`${file}\` has exactly the content in the objective`,
      "No other file changes",
      `\`tandem specialists\` lists ${input.name} from the repository with no problems`,
    ],
    manualVerification: ["Read the specialist and agree the team should use it"],
    surfaces: [file],
    specialist: FALLBACK_SPECIALIST,
    ...(input.target === "project"
      ? {}
      : { targetRepo: input.target.repo, targetCheckout: input.target.path }),
  };
}
