import type { Clock, TaskRecord } from "../contracts.ts";
import type { PrWatch } from "../pr-watch/store.ts";
import {
  archiveWorkstream,
  listWorkstreams,
  memoryPath,
  memoryRoot,
  readWorkstream,
  saveWorkstream,
} from "./store.ts";
import type { MemoryShowResult } from "./view.ts";
import {
  catchUpView,
  MEMORY_SECTIONS,
  type MemorySection,
  recentWork,
  type SectionChanges,
  workstreamLine,
  workstreamName,
} from "./workstream.ts";

export type MemoryWriteInput = Readonly<{
  readonly repoPath: string;
  readonly workstream: string;
  readonly changes: SectionChanges;
}>;

export type ProjectMemoryDependencies = Readonly<{
  readonly home: string;
  readonly clock: Clock;
  /** The project a coordinator-given path belongs to, so a clean checkout maps to its original. */
  readonly projectPath: (repoPath: string) => Promise<string>;
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  readonly listWatches: () => Promise<readonly PrWatch[]>;
}>;

/** A project's workstream notes: what the `memory-*` actions read and write (project-memory.md). */
export class ProjectMemory {
  readonly #deps: ProjectMemoryDependencies;

  constructor(deps: ProjectMemoryDependencies) {
    this.#deps = deps;
  }

  /** One line per workstream with what is due; empty when the user never named one. */
  async lines(repoPath: string): Promise<readonly string[]> {
    const now = this.#deps.clock();
    const saved = await listWorkstreams(await this.root(repoPath));
    return saved.map(({ memory }) => workstreamLine(memory, now));
  }

  /** One workstream's catch-up, or that it has no notes yet. */
  async show(repoPath: string, workstream: string): Promise<MemoryShowResult> {
    const name = workstreamName(workstream);
    const now = this.#deps.clock();
    const root = await this.root(repoPath);
    const [saved, tasks, watches] = await Promise.all([
      readWorkstream(root, name),
      this.#deps.listTasks(),
      this.#deps.listWatches(),
    ]);
    if (saved === undefined) return { kind: "none", name };
    return {
      kind: "notes",
      view: catchUpView({
        memory: saved.memory,
        path: memoryPath(root, name),
        savedAt: saved.savedAt,
        now,
        recent: recentWork(tasks, watches, name),
      }),
    };
  }

  async write(input: MemoryWriteInput): Promise<string> {
    const written = MEMORY_SECTIONS.filter((section) => input.changes[section] !== undefined);
    if (written.length === 0) throw new TypeError("memory-write needs at least one section");
    const result = await saveWorkstream(
      await this.root(input.repoPath),
      input.workstream,
      input.changes,
      this.#deps.clock(),
    );
    if (result.kind === "refused") throw new Error(`Not saved: ${result.reason}`);
    return `Saved ${result.saved.memory.name}: ${written.map(sectionLabel).join(", ")}.`;
  }

  /** The user said a workstream is done: its notes move out of the list and are kept. */
  async done(repoPath: string, workstream: string): Promise<string> {
    await archiveWorkstream(await this.root(repoPath), workstream, this.#deps.clock());
    return `Archived ${workstreamName(workstream)}. Its notes are kept but it is no longer listed.`;
  }

  private async root(repoPath: string): Promise<string> {
    return memoryRoot(await this.#deps.projectPath(repoPath), this.#deps.home);
  }
}

function sectionLabel(section: MemorySection): string {
  return section === "last-handoff" ? "last handoff" : section;
}
