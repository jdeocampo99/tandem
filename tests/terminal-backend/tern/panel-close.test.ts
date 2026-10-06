import { expect, test } from "bun:test";
import type { CommandRunner } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { TernOutcomeUnknownError } from "../../../src/terminal-backend/tern/protocol.ts";

for (const mode of ["failed", "malformed", "detached", "still-present", "confirmed"] as const) {
  test(`panel close ${mode} verification fences every unconfirmed effect`, async () => {
    let closes = 0;
    let readsAfterClose = 0;
    const run: CommandRunner = async (request) => {
      const verb = request.argv[1];
      if (verb === "close") {
        closes++;
        expect(request.argv[2]).toBe("4");
        return { code: 0, stderr: "", stdout: '{"block":"4"}' };
      }
      if (verb === "process")
        return {
          code: 0,
          stderr: "",
          stdout: '{"pane":"4","child":null,"foreground":null,"group":null}',
        };
      if (verb !== "ls") throw new Error(`Unexpected panel proof command ${verb}`);
      if (closes > 0 && readsAfterClose++ === 0) {
        if (mode === "failed") return { code: 1, stderr: "lost close snapshot", stdout: "" };
        if (mode === "malformed") return { code: 0, stderr: "", stdout: "malformed" };
      }
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          sessions: [
            {
              id: "1",
              name: "fixture",
              tabs: [
                {
                  id: "2",
                  name: null,
                  blocks: [
                    { id: "3", title: "Coordinator", cwd: "/tmp/panel-fixture", live: true },
                    // Keep the panel visible on retry so an unfenced call would close twice.
                    ...(closes === 0 || mode !== "confirmed"
                      ? [
                          {
                            id: "4",
                            title: "Panel",
                            cwd: "/tmp/panel-fixture",
                            live: false,
                            program: "tandem.panel",
                            args: ["fixture.json", "3"],
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
          ],
          detached: closes > 0 && mode === "detached" ? [{}] : [],
        }),
      };
    };
    const terminal = ternBackend(run, { binary: "tern" });
    const close = () =>
      terminal.closePanel({
        sessionId: "fixture",
        cwd: "/tmp/panel-fixture",
        panelPaneId: "4",
      });
    if (mode === "confirmed") await close();
    else {
      await expect(close()).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      await expect(close()).rejects.toThrow("quarantine");
    }
    expect(closes).toBe(1);
  });
}
