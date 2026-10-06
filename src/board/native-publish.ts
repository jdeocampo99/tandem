import { recordNativePublication } from "../memory/native-visits.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { NativeAlerts } from "./native-alerts.ts";
import { type NativeReadDependencies, NativeViewsReader } from "./native-read.ts";
import { type BoardSnapshot, writeNativeViews } from "./snapshot.ts";

type PublicationInput = Readonly<{
  snapshot: BoardSnapshot;
  project: string;
  sessions: ReadonlyMap<string, Readonly<{ terminal: string; sessionId: string }>>;
}>;

/** One background writer per coordinator. Slow reads coalesce ticks to the newest snapshot. */
export class NativeViewsPublisher {
  readonly #deps: NativeReadDependencies;
  readonly #reader: NativeViewsReader;
  readonly #alerts: NativeAlerts;
  #pending: PublicationInput | undefined;
  #running: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;

  constructor(deps: NativeReadDependencies) {
    this.#deps = deps;
    this.#reader = new NativeViewsReader(deps);
    this.#alerts = new NativeAlerts(deps);
  }

  schedule(input: PublicationInput): void {
    if (this.#closed) return;
    this.#pending = input;
    if (this.#busy) return;
    this.#busy = true;
    this.#running = Promise.resolve().then(async () => {
      try {
        while (this.#pending !== undefined) {
          const next = this.#pending;
          this.#pending = undefined;
          try {
            const session = next.sessions.get(next.project);
            if (session?.terminal === "tern")
              await this.#alerts.observe(next.snapshot, next.project, session.sessionId);
            const view = await this.#reader.read(next.snapshot, next.project, next.sessions);
            await writeNativeViews(this.#deps.home, view);
            await recordNativePublication({
              home: this.#deps.home,
              project: next.project,
              signature: view.bundle.changeSignature,
            });
          } catch (error) {
            await appendDiagnosticEvent(
              this.#deps.home,
              {
                event: "native-views-publish-failed",
                details: { errorClass: error instanceof Error ? error.name : typeof error },
              },
              this.#deps.clock,
            );
          }
        }
      } finally {
        this.#busy = false;
      }
    });
  }

  /** Finish the last queued publication, then drain provider/GitHub cache reads. */
  async settle(): Promise<void> {
    this.#closed = true;
    await this.#running;
    await this.#reader.settle();
  }
}
