import type { TerminalBackend, ViewsCapability } from "../../src/terminal-backend/contract.ts";

/** The native views of a terminal a test selected for hosting them. */
export function viewsOf(terminal: TerminalBackend): ViewsCapability {
  if (terminal.views === undefined) throw new Error(`${terminal.name} hosts no native views`);
  return terminal.views;
}

const unexpected = async (): Promise<never> => {
  throw new Error("This fixture hosts no native view for that call");
};

/** The terminal's views, or a fixture that hosts none, with the calls a test observes replaced. */
export function viewsWith(
  terminal: TerminalBackend,
  overrides: Partial<ViewsCapability>,
): ViewsCapability {
  return {
    ...(terminal.views ?? {
      open: unexpected,
      close: unexpected,
      isView: unexpected,
      recover: async () => {},
      retained: async () => [],
      abandon: unexpected,
    }),
    ...overrides,
  };
}
