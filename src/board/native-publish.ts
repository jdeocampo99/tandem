import { recordNativePublication } from "../memory/native-visits.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { NativeAlerts } from "./native-alerts.ts";
import { type NativeReadDependencies, NativeViewsReader } from "./native-read.ts";
import { type BoardSnapshot, publishNativeViews } from "./snapshot.ts";

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
            if (session?.terminal === "tern") {
              await this.#recoverOpens();
              await this.#alerts.observe(next.snapshot, next.project, session.sessionId);
            }
            const view = await publishNativeViews(this.#deps.home, next.project, () =>
              this.#reader.read(next.snapshot, next.project, next.sessions),
            );
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

  /** A late receipt settles its paused open here, without waiting for the user's next click. */
  async #recoverOpens(): Promise<void> {
    try {
      await this.#deps.terminal.recoverViewOpens(this.#deps.home);
    } catch (error) {
      await appendDiagnosticEvent(
        this.#deps.home,
        {
          event: "native-open-recovery-failed",
          details: { errorClass: error instanceof Error ? error.name : typeof error },
        },
        this.#deps.clock,
      );
    }
  }

  /** Resolves once queued publications and the remote reads they started have finished. */
  async idle(): Promise<void> {
    let running: Promise<void>;
    do {
      running = this.#running;
      await running;
    } while (running !== this.#running);
    await this.#reader.idle();
  }

  /** Finish the last queued publication, then drain provider/GitHub cache reads. */
  async settle(): Promise<void> {
    this.#closed = true;
    await this.#running;
    await this.#reader.settle();
  }
}
