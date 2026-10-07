import { expect, test } from "bun:test";
import type { CommandRequest } from "../../src/contracts.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { parseTerminalArgs } from "../../src/terminal/arguments.ts";
import { launchProjects } from "../../src/terminal/launch.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

async function launchFromTern(source: Readonly<Record<string, string>>) {
  const focused: string[] = [];
  const attached: (readonly string[])[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("the fake terminal runs no commands");
  };
  const terminal = {
    ...terminalBackend(unexpected, { terminal: "tern" }),
    focusWorkspace: async (target: Readonly<{ workspaceId: string }>) => {
      focused.push(target.workspaceId);
      return { focused: true as const };
    },
  };
  await launchProjects(
    ["/repo"],
    parseTerminalArgs([]),
    { cwd: "/repo", home: "/home/.tandem", sessionId: "tandem", poolRoot: "/pool", source },
    {
      application: {
        invoke: async (invocation) => ({
          command: invocation.command,
          value: { workspaceId: "41" },
        }),
        shutdown: async () => undefined,
      },
      runInteractive: async (request: CommandRequest) => {
        attached.push(request.argv);
        return 0;
      },
      isTTY: true,
    },
    {} as TandemService,
    unexpected,
    terminal,
  );
  return { focused, attached };
}

test("launching from the user's own Tern tab shows the coordinator there without a second window", async () => {
  expect(await launchFromTern({ TERN_PANE: "7", TERN_WINDOW_KEY: "w1" })).toEqual({
    focused: ["41"],
    attached: [],
  });
});

test("launching from outside Tern opens a Tern window after focusing the coordinator", async () => {
  const { focused, attached } = await launchFromTern({});
  expect(focused).toEqual(["41"]);
  expect(attached).toHaveLength(1);
});
