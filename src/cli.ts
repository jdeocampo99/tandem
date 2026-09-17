import { summarizeTandemActionValue } from "./extension/summary.ts";
import { type CliDependencies, createCliApplication } from "./terminal/cli-application.ts";
import {
  type CliCommand,
  CliConsentError,
  type CliRunResult,
  CliUsageError,
  parseCliArgs,
} from "./terminal/cli-arguments.ts";
import {
  CliInterruptError,
  type CliSignal,
  defaultCliSignalSource,
} from "./terminal/cli-process.ts";

function renderValue(value: unknown, json: boolean, command?: CliCommand): string {
  if (json) return JSON.stringify(value) ?? "null";
  if (command === "steer" || command === "answer" || command === "messages") {
    return summarizeTandemActionValue(command, value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<CliRunResult> {
  const application = createCliApplication(dependencies);
  const failure = (error: unknown): CliRunResult => {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const json = argv.includes("--json") || argv.some((argument) => argument.startsWith("--json="));
    const output = json ? JSON.stringify({ error: { name, message } }) : `tandem: ${message}`;
    (dependencies.stderr ?? ((value: string) => process.stderr.write(value)))(`${output}\n`);
    return {
      exitCode: error instanceof CliUsageError || error instanceof CliConsentError ? 2 : 1,
      error: { name, message },
    };
  };
  let outcome: CliRunResult;
  let removeSignalHandlers: (() => void) | undefined;
  let interruption: CliInterruptError | undefined;
  try {
    const invocation = parseCliArgs(argv);
    const ownsPolling =
      invocation.command === "watch" ||
      invocation.command === "tick" ||
      invocation.command === "feedback";
    const controller = ownsPolling ? new AbortController() : undefined;
    if (controller !== undefined) {
      const processSignals = dependencies.processSignals ?? defaultCliSignalSource;
      const interrupt = (signal: CliSignal): void => {
        if (interruption !== undefined) return;
        interruption = new CliInterruptError(signal);
        controller.abort(interruption);
        void application.shutdown().catch(() => undefined);
      };
      const onSigint = (): void => interrupt("SIGINT");
      const onSigterm = (): void => interrupt("SIGTERM");
      processSignals.on("SIGINT", onSigint);
      processSignals.on("SIGTERM", onSigterm);
      removeSignalHandlers = (): void => {
        processSignals.removeListener("SIGINT", onSigint);
        processSignals.removeListener("SIGTERM", onSigterm);
      };
    }
    const result = await application.invoke(invocation, controller?.signal);
    if (interruption !== undefined) throw interruption;
    const output = renderValue(result.value, invocation.options.json, result.command);
    (dependencies.stdout ?? ((value: string) => process.stdout.write(value)))(
      `${output}${output.endsWith("\n") ? "" : "\n"}`,
    );
    outcome = { exitCode: 0, result };
  } catch (error) {
    outcome = failure(interruption ?? error);
  }
  try {
    await application.shutdown();
  } catch (error) {
    outcome = failure(interruption ?? error);
  } finally {
    removeSignalHandlers?.();
  }
  if (interruption !== undefined && outcome.exitCode === 0) outcome = failure(interruption);
  return outcome;
}

if (import.meta.main) {
  const result = await runCli();
  process.exitCode = result.exitCode;
}
