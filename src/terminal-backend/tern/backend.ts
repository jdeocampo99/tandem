import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { z } from "zod";
import { quoteShellCommand } from "../../adapters/commands.ts";
import {
  AdapterError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../../contracts.ts";
import type { EndpointTarget, SessionTarget, TerminalBackend } from "../contract.ts";
import { close, exactPane, inspect, missing, paneMutation, runCommand } from "./endpoints.ts";
import {
  blocks,
  Created,
  Id,
  isDaemonGone,
  type LocatedBlock,
  type TernOptions,
  TernOutcomeUnknownError,
  TernUnsupportedOperationError,
  ternCommands,
} from "./protocol.ts";

export type TernBackendOptions = TernOptions &
  Readonly<{
    /** Durable composition may supply an owned alert pane after a restart. */
    notificationEndpoint?: (target: SessionTarget) => Promise<Endpoint | undefined>;
    clock?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  }>;

/** Tern's daemon is the port session; a Tern tab supplies both workspaceId and tabId. */
export function ternBackend(run: CommandRunner, options: TernBackendOptions = {}): TerminalBackend {
  const commands = ternCommands(run, options);
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  // Durable runtime quarantines a rejected effect; this guard also prevents local blind retries.
  const quarantined = new Set<string>();
  const guard = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (quarantined.has(key))
      throw new TernOutcomeUnknownError(key, "an earlier effect is quarantined");
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TernOutcomeUnknownError) quarantined.add(key);
      throw error;
    }
  };
  const check = (target: EndpointTarget) => inspect(commands, target);
  const endpointFor = (target: SessionTarget, entry: LocatedBlock): Endpoint => ({
    sessionId: target.sessionId,
    terminalSessionId: entry.session.id,
    workspaceId: entry.tab.id,
    tabId: entry.tab.id,
    paneId: entry.block.id,
    role: "coordinator",
    generation: 0,
  });
  const byId = async (target: SessionTarget, paneId: string): Promise<Endpoint> => {
    const found = blocks(await commands.ls(target.cwd)).find((entry) => entry.block.id === paneId);
    const endpoint: Endpoint = {
      sessionId: target.sessionId,
      workspaceId: "unknown",
      tabId: "unknown",
      paneId,
      role: "coordinator",
      generation: 0,
    };
    if (found === undefined) throw missing(endpoint);
    return endpointFor(target, found);
  };
  const paneEffect = (target: EndpointTarget, args: readonly string[]) =>
    guard(target.endpoint.paneId, () => paneMutation(commands, target, args));
  const rename = async (target: SessionTarget & { workspaceId: string; label: string }) => {
    const found = blocks(await commands.ls(target.cwd)).find(
      (entry) => entry.tab.id === target.workspaceId,
    );
    if (found === undefined) throw new AdapterError("exact Tern tab is absent", "tern rename");
    const endpoint = endpointFor(target, found);
    await paneEffect({ endpoint, cwd: target.cwd }, ["rename", endpoint.paneId, target.label]);
    try {
      const tab = blocks(await commands.ls(target.cwd)).find(
        (entry) => entry.tab.id === target.workspaceId,
      )?.tab;
      if (tab?.name !== target.label) throw new Error("new tab label not confirmed");
    } catch (cause) {
      throw new TernOutcomeUnknownError("tern rename verification", cause);
    }
  };
  const focus = async (target: SessionTarget, paneId: string) => {
    try {
      await paneEffect({ endpoint: await byId(target, paneId), cwd: target.cwd }, [
        "focus",
        paneId,
      ]);
      return { focused: true as const };
    } catch (error) {
      return { focused: false as const, code: 1, detail: String(error) };
    }
  };
  return {
    name: "tern",
    openView: async ({ view }) => ({
      opened: false,
      warnings: [
        `Tern ${view.kind} view is unavailable until Tandem's native views are installed.`,
      ],
    }),
    inspect: check,
    runCommand: (target) => guard(target.endpoint.paneId, () => runCommand(commands, target)),
    sendKeys: (target) =>
      paneEffect(target, ["send", target.endpoint.paneId, "keys", ...target.keys]),
    interrupt: async (target) => {
      const timeoutMs = target.timeoutMs ?? 10_000;
      const pollIntervalMs = target.pollIntervalMs ?? 100;
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 0 ||
        !Number.isFinite(pollIntervalMs) ||
        pollIntervalMs < 0
      )
        throw new TypeError("interrupt timings must be finite and non-negative");
      if (!(await check(target)).activeWorker) return { wasRunning: false };
      await paneEffect(target, ["send", target.endpoint.paneId, "keys", target.key ?? "ctrl+c"]);
      const deadline = clock() + timeoutMs;
      while ((await check(target)).activeWorker) {
        if (clock() >= deadline) throw new EndpointBusyError(target.endpoint);
        await wait(pollIntervalMs);
      }
      return { wasRunning: true };
    },
    close: async (target) => {
      await guard(target.endpoint.paneId, () => close(commands, target));
    },
    closeOwned: async (target) => {
      await guard(target.endpoint.paneId, () => close(commands, { ...target, force: true }, true));
    },
    isPaneGone: (error) => error instanceof EndpointOwnershipError && error.reason === "missing",
    isEndpointGone: (error) =>
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      isDaemonGone(error),
    createWorkspace: (target) =>
      guard(`create:${target.sessionId}:${target.cwd}:${target.label}`, async () => {
        let created: z.infer<typeof Created>;
        if (target.parentWorkspaceId !== undefined) {
          const parent = blocks(await commands.ls(target.cwd)).find(
            (entry) => entry.tab.id === target.parentWorkspaceId,
          );
          if (parent === undefined)
            throw new AdapterError("exact parent Tern tab is absent", "tern new tab");
          // Recheck the session id immediately before creating its background tab.
          if (
            !(await commands.ls(target.cwd)).sessions.some(
              (entry) =>
                entry.id === parent.session.id &&
                entry.tabs.some((tab) => tab.id === target.parentWorkspaceId),
            )
          )
            throw new AdapterError("parent Tern session changed", "tern new tab");
          created = await commands.mutate(
            target.cwd,
            ["new", "tab", parent.session.id, "--cwd", target.cwd],
            Created,
          );
          if (created.session !== parent.session.id)
            throw new TernOutcomeUnknownError("tern new tab", "new tab belongs to another session");
        } else {
          const previous = target.previousEndpoint;
          if (previous !== undefined && previous.sessionId !== target.sessionId)
            throw new EndpointOwnershipError(
              previous,
              "previous endpoint belongs to another daemon namespace",
            );
          const storedSession = previous?.terminalSessionId;
          if (
            previous !== undefined &&
            storedSession !== undefined &&
            !Id.safeParse(storedSession).success
          )
            throw new EndpointOwnershipError(previous, "stored Tern session id is invalid");
          const suffix = createHash("sha256")
            .update(`${target.sessionId}\0${target.cwd}`)
            .digest("hex")
            .slice(0, 12);
          const baseName = `tandem-${basename(target.cwd)}-${suffix}`;
          const existing = await commands.ls(target.cwd);
          if (
            storedSession !== undefined &&
            existing.sessions.some((entry) => entry.id === storedSession)
          ) {
            // Never look up the old project by name. This read is the final call before the effect.
            if (
              !(await commands.ls(target.cwd)).sessions.some((entry) => entry.id === storedSession)
            )
              throw new AdapterError("stored Tern session changed", "tern new tab");
            created = await commands.mutate(
              target.cwd,
              ["new", "tab", storedSession, "--cwd", target.cwd],
              Created,
            );
            if (created.session !== storedSession)
              throw new TernOutcomeUnknownError(
                "tern new tab",
                "new tab belongs to another session",
              );
          } else {
            let name = baseName;
            let collision = 0;
            // Names prevent collisions only. Never adopt a pane or an empty retained session by title.
            while (existing.sessions.some((entry) => entry.name === name)) {
              collision += 1;
              name = `${baseName}-${collision}`;
            }
            created = await commands.mutate(
              target.cwd,
              ["new", "session", name, "--cwd", target.cwd],
              Created,
            );
          }
        }
        const endpoint: Endpoint = {
          sessionId: target.sessionId,
          terminalSessionId: created.session,
          workspaceId: created.tab,
          tabId: created.tab,
          paneId: created.block,
          role: target.role,
          generation: target.generation,
        };
        try {
          const confirmed = await exactPane(commands, { endpoint, cwd: target.cwd });
          if (confirmed.session.id !== created.session)
            throw new Error("created session acknowledgement disagrees with listing");
        } catch (cause) {
          throw new TernOutcomeUnknownError("tern new verification", cause);
        }
        await rename({ ...target, workspaceId: endpoint.workspaceId });
        if (target.env !== undefined && Object.keys(target.env).length > 0) {
          // Environment belongs to the shell running the eventual command, not the CLI client.
          const exports = Object.entries(target.env).map(([key, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
              throw new TypeError(`invalid environment key ${key}`);
            return `${key}=${value}`;
          });
          await paneMutation(commands, { endpoint, cwd: target.cwd }, [
            "run",
            endpoint.paneId,
            quoteShellCommand(["export", ...exports]),
          ]);
        }
        return {
          endpoint,
          warnings:
            target.parentWorkspaceId === undefined
              ? []
              : ["Tern cannot reorder tabs; the worker remains in creation order."],
        };
      }),
    splitBeside: (input) =>
      guard(`split:${"anchor" in input ? input.anchor.paneId : input.anchorPaneId}`, async () => {
        const anchor = "anchor" in input ? input.anchor : await byId(input, input.anchorPaneId);
        const placement = await exactPane(commands, { endpoint: anchor, cwd: input.cwd });
        const created = await commands.mutate(
          input.cwd,
          ["split", anchor.paneId, "right", "--cwd", input.cwd],
          Created,
        );
        if (
          created.session !== placement.session.id ||
          created.tab !== anchor.tabId ||
          created.block === anchor.paneId
        )
          throw new TernOutcomeUnknownError(
            "tern split",
            "split did not land beside the exact anchor",
          );
        const endpoint: Endpoint = {
          ...anchor,
          terminalSessionId: created.session,
          paneId: created.block,
          role: input.role,
          generation: input.generation,
        };
        try {
          await exactPane(commands, { endpoint, cwd: input.cwd });
        } catch (cause) {
          throw new TernOutcomeUnknownError("tern split verification", cause);
        }
        return endpoint;
      }),
    listWorkspaces: async (target) =>
      (await commands.ls(target.cwd)).sessions.flatMap((session) =>
        session.tabs.map((tab) => ({
          workspaceId: tab.id,
          activeTabId: tab.id,
          label: tab.name ?? tab.blocks[0]?.title ?? "",
        })),
      ),
    orderWorkspaceAfter: async () => [
      "Tern cannot reorder tabs; the workspace remains in creation order.",
    ],
    workspaceLabel: async (target) =>
      (await commands.ls(target.cwd)).sessions
        .flatMap((session) => session.tabs)
        .find((tab) => tab.id === target.workspaceId)?.name ?? undefined,
    renameWorkspace: (target) => guard(target.workspaceId, () => rename(target)),
    listPanes: async (target) =>
      blocks(await commands.ls(target.cwd))
        .filter((entry) => target.workspaceId === undefined || entry.tab.id === target.workspaceId)
        .map((entry) => ({
          paneId: entry.block.id,
          tabId: entry.tab.id,
          workspaceId: entry.tab.id,
          cwd: entry.block.cwd,
        })),
    snapshot: async (target) => {
      try {
        return blocks(await commands.ls(target.cwd)).map((entry) => ({
          workspaceId: entry.tab.id,
          tabId: entry.tab.id,
          paneId: entry.block.id,
        }));
      } catch (error) {
        if (target.allowMissingSession === true && isDaemonGone(error)) return [];
        throw error;
      }
    },
    focusWorkspace: async (target) => {
      const entry = blocks(await commands.ls(target.cwd)).find(
        (entry) => entry.tab.id === target.workspaceId,
      );
      return entry === undefined
        ? { focused: false, code: 1, detail: "exact Tern tab is absent" }
        : focus(target, entry.block.id);
    },
    focusAgent: async (target) => (await focus(target, target.paneId)).focused,
    sessionRunning: async (target) => {
      try {
        await commands.ls(target.cwd);
        return true;
      } catch (error) {
        if (isDaemonGone(error)) return false;
        throw error;
      }
    },
    sessionDetail: async (target) => {
      const listing = await commands.ls(target.cwd);
      return `Tern daemon: ${listing.sessions.length} sessions`;
    },
    serverCommand: () => [commands.binary, "daemon"],
    clientCommand: () => [commands.binary],
    checkInstall: async (target) => {
      try {
        const version = await run({ argv: [commands.binary, "--version"], cwd: target.cwd });
        return [
          {
            name: "Tern",
            ok: version.code === 0,
            detail: version.code === 0 ? version.stdout.trim() : "not available",
          },
        ];
      } catch {
        return [
          {
            name: "Tern",
            ok: false,
            detail: "not installed",
            fix: "Install Tern from https://stencil.so/tern",
          },
        ];
      }
    },
    notify: async (target) => {
      const endpoint = await options.notificationEndpoint?.(target);
      if (endpoint === undefined)
        throw new AdapterError("Tern alert requires a recorded Tandem-owned pane", "tern notify");
      if (endpoint.sessionId !== target.sessionId)
        throw new EndpointOwnershipError(
          endpoint,
          "notification endpoint belongs to another daemon namespace",
        );
      const inspected = await check({ endpoint, cwd: target.cwd });
      const pid = inspected.processInfo.shellPid;
      if (pid === undefined)
        throw new AdapterError("Tern alert pane has no tty process", "tern notify");
      const tty = await run({ argv: ["ps", "-o", "tty=", "-p", String(pid)], cwd: target.cwd });
      const name = tty.stdout.trim();
      if (tty.code !== 0 || !/^ttys\d+$/u.test(name))
        throw new AdapterError("Tern alert tty could not be proven", "tern notify");
      const clean = (text: string) =>
        [...text]
          .map((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || (code >= 127 && code <= 159) || char === ";" ? " " : char;
          })
          .join("");
      const osc = `\x1b]777;notify;${clean(target.title)};${clean(target.body)}\x07`;
      const current = await inspect(commands, { endpoint, cwd: target.cwd });
      if (current.processInfo.shellPid !== pid)
        throw new EndpointOwnershipError(endpoint, "notification tty process changed");
      await exactPane(commands, { endpoint, cwd: target.cwd });
      const write = await guard(endpoint.paneId, async () => {
        try {
          return await run({
            argv: [
              process.execPath,
              "-e",
              "await Bun.write(Bun.file(process.argv[1]), process.argv[2]);",
              `/dev/${name}`,
              osc,
            ],
            cwd: target.cwd,
          });
        } catch (cause) {
          throw new TernOutcomeUnknownError("tern notify", cause);
        }
      });
      if (write.code !== 0) {
        quarantined.add(endpoint.paneId);
        throw new TernOutcomeUnknownError("tern notify", "tty write failed");
      }
    },
    openWelcome: async () => {
      throw new TernUnsupportedOperationError("welcome");
    },
    promptAgent: async (target) => {
      const endpoint = await byId(target, target.paneId);
      await paneEffect({ endpoint, cwd: target.cwd }, [
        "send",
        endpoint.paneId,
        "text",
        `${target.text}\r`,
      ]);
    },
    openPanel: async () => {
      throw new TernUnsupportedOperationError("panel");
    },
    isPanelOpen: async () => {
      throw new TernUnsupportedOperationError("panel inspection");
    },
    closePanel: async () => {
      throw new TernUnsupportedOperationError("panel close");
    },
    fitPanel: async (target) => ({
      fittedWidth: target.fittedWidth,
      warnings: ["Tern cannot resize panes; panel width is unchanged."],
    }),
    agentStatusReporter: () => undefined,
  };
}
