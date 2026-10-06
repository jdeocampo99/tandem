import { dirname, relative } from "node:path";
import { entryName, type SpecialistEntry, type SpecialistRegistry } from "./registry.ts";
import type { Specialist, SpecialistOrigin } from "./specialist.ts";

const ORIGIN_WORDS: Readonly<Record<SpecialistOrigin, string>> = {
  "built-in": "built-in",
  repository: "repository",
  home: "home",
};
const DIGEST_CHARS = 12;

/** `Blog writer (blog-writer, from the repository)`: the summary's Specialist line. */
export function specialistLine(specialist: Pick<Specialist, "name" | "label" | "origin">): string {
  const origin =
    specialist.origin === "built-in"
      ? "built-in"
      : specialist.origin === "repository"
        ? "from the repository"
        : "from your Tandem home";
  return `${specialist.label} (${specialist.name}, ${origin})`;
}

/** What `tandem specialists` prints and the `specialists` action returns. */
export function renderSpecialistList(registry: SpecialistRegistry, projectName: string): string {
  const checkout = dirname(dirname(registry.folders.repository));
  const shown = (path: string) =>
    path.startsWith(registry.folders.repository) ? relative(checkout, path) : path;
  const rows = registry.entries.map((entry) => row(entry, shown));
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  );
  const lines = [
    `Specialists for ${projectName}`,
    `  Repository  ${registry.folders.repository}`,
    `  Home        ${registry.folders.home}`,
    "",
    ...rows.map((cells) =>
      `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd(),
    ),
  ];
  if (registry.problems.length > 0) {
    lines.push(
      "",
      `${registry.problems.length} ${registry.problems.length === 1 ? "problem" : "problems"}`,
      ...registry.problems.map(({ path, problem }) =>
        path === undefined ? `  ${problem}` : `  ${shown(path)} ${problem}`,
      ),
    );
  }
  return lines.join("\n");
}

function row(entry: SpecialistEntry, shown: (path: string) => string): readonly string[] {
  const replaces = entry.replaces.includes("built-in") ? ", replaces built-in" : "";
  if (entry.status === "broken") {
    return [
      entry.name,
      "unavailable",
      `${ORIGIN_WORDS[entry.origin]}${replaces}`,
      "",
      `Fix ${shown(entry.path)} (see problems).`,
    ];
  }
  const { specialist } = entry;
  const description = specialist.description ?? "Used only when named (no description).";
  return [
    entryName(entry),
    specialist.label,
    `${ORIGIN_WORDS[specialist.origin]}${replaces}`,
    specialist.digest.slice(0, DIGEST_CHARS),
    description,
  ];
}
