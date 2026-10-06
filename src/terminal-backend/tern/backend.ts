import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { z } from "zod";
import {
  AdapterError,
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import type { CommandRunner, Endpoint, TerminalPaneLocation } from "../../contracts.ts";
import { blockArgs, parseBlockArgs } from "../../native/contract.ts";
import type { EndpointTarget, SessionTarget, TerminalBackend } from "../contract.ts";
import { probeTern } from "./availability.ts";
import {
  close,
  exactPane,
  initializeShell,
  inspect,
  missing,
  paneMutation,
  runCommand,
} from "./endpoints.ts";
import {
  BlockAck,
  blocks,
  Created,
  Id,
  isDaemonGone,
  type LocatedBlock,
  Processes,
  type TernOptions,
  TernOutcomeUnknownError,
  ternCommands,
} from "./protocol.ts";

export type TernBackendOptions = TernOptions &
  Readonly<{
    /** Resolve only the recorded dedicated helper, including after a restart. */
    home?: string;
    notificationEndpoint?: (target: SessionTarget) => Promise<Endpoint | undefined>;
    clock?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  }>;

/** Resolve the recorded helper without discovering a substitute pane by title or placement. */
export function ternNotificationEndpoint(owner: Endpoint): Endpoint | undefined {
  if (owner.notificationPane === undefined) return undefined;
  if (owner.terminalSessionId === undefined || owner.notificationPane.paneId === owner.paneId)
    throw new EndpointOwnershipError(
      owner,
      "recorded alert helper lacks an independent native identity",
    );
  return {
    terminal: owner.terminal,
    sessionId: owner.sessionId,
    terminalSessionId: owner.terminalSessionId,
    ...owner.notificationPane,
    role: "coordinator",
    generation: 0,
  };
}

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
  // An open records its own uncertain outcome as a durable ticket, so only a pane quarantine
  // from another effect refuses it here.
  const guardOpen = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (quarantined.has(key))
      throw new TernOutcomeUnknownError(key, "an earlier effect is quarantined");
    return operation();
  };
  const check = async (target: EndpointTarget) => {
    try {
      return await inspect(commands, target);
    } catch (error) {
      if (
        error instanceof AdapterProtocolError &&
        error.operation === "Tern foreground process proof"
      ) {
        const { quarantineCoordinatorProof } = await import("./retire-views.ts");
        await quarantineCoordinatorProof(options.home, target, error.message);
      }
      throw error;
    }
  };
  const endpointFor = (target: SessionTarget, entry: LocatedBlock): Endpoint => ({
    terminal: "tern",
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
      terminal: "tern",
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
  const focus = async (target: EndpointTarget) => {
    try {
      await paneEffect(target, ["focus", target.endpoint.paneId]);
      return { focused: true as const };
    } catch (error) {
      return { focused: false as const, code: 1, detail: String(error) };
    }
  };
  const createNotificationPane = async (
    owner: EndpointTarget,
    previous: Endpoint | undefined,
  ): Promise<TerminalPaneLocation> => {
    const stored =
      previous !== undefined && previous.terminalSessionId === owner.endpoint.terminalSessionId
        ? ternNotificationEndpoint(previous)
        : undefined;
    if (stored !== undefined) {
      try {
        await exactPane(commands, { endpoint: stored, cwd: owner.cwd });
        return { workspaceId: stored.workspaceId, tabId: stored.tabId, paneId: stored.paneId };
      } catch (error) {
        if (!(error instanceof EndpointOwnershipError && error.reason === "missing")) throw error;
      }
    }
    const placement = await exactPane(commands, owner);
    const created = await commands.mutate(
      owner.cwd,
      ["new", "tab", placement.session.id, "--cwd", owner.cwd],
      Created,
    );
    if (
      created.session !== placement.session.id ||
      created.block === owner.endpoint.paneId ||
      created.tab === owner.endpoint.tabId
    )
      throw new TernOutcomeUnknownError(
        "tern alert helper",
        "helper creation acknowledged another placement",
      );
    const helper: Endpoint = {
      terminal: "tern",
      sessionId: owner.endpoint.sessionId,
      terminalSessionId: created.session,
      workspaceId: created.tab,
      tabId: created.tab,
      paneId: created.block,
      role: "coordinator",
      generation: 0,
    };
    await exactPane(commands, { endpoint: helper, cwd: owner.cwd });
    await initializeShell(commands, { endpoint: helper, cwd: owner.cwd });
    await rename({
      sessionId: helper.sessionId,
      workspaceId: helper.workspaceId,
      cwd: owner.cwd,
      label: "Tandem alerts",
    });
    return { workspaceId: helper.workspaceId, tabId: helper.tabId, paneId: helper.paneId };
  };
  const closeWithNotification = (
    target: EndpointTarget & Readonly<{ force?: boolean }>,
    strict: boolean,
  ) =>
    guard(target.endpoint.paneId, async () => {
      const helper = ternNotificationEndpoint(target.endpoint);
      if (helper !== undefined) {
        for (const endpoint of [target.endpoint, helper]) {
          try {
            if (
              (await inspect(commands, { endpoint, cwd: target.cwd })).activeWorker &&
              target.force !== true
            )
              throw new EndpointBusyError(endpoint);
          } catch (error) {
            if (
              !(error instanceof EndpointOwnershipError && error.reason === "missing") ||
              (strict && endpoint === target.endpoint)
            )
              throw error;
          }
        }
      }
      const { planCoordinatorViews } = await import("./retire-views.ts");
      const retireViews = await planCoordinatorViews(commands, options.home, target);
      // Prove the conversation before retiring views, then recheck it in close itself.
      try {
        if ((await check(target)).activeWorker && target.force !== true)
          throw new EndpointBusyError(target.endpoint);
      } catch (error) {
        if (strict || !(error instanceof EndpointOwnershipError && error.reason === "missing"))
          throw error;
      }
      await close(commands, target, strict, { clock, wait });
      await retireViews();
      if (helper !== undefined)
        await guard(helper.paneId, () =>
          close(
            commands,
            {
              endpoint: helper,
              cwd: target.cwd,
              ...(target.force === undefined ? {} : { force: target.force }),
            },
            false,
            { clock, wait },
          ),
        );
    });
  // Native screens load coordinator/model code only when requested. Ordinary worker startup
  // must not load the interactive harness through this terminal port.
  const native = async () => {
    const [{ ternViewHost, projectForView }, { nativeViewsPath }] = await Promise.all([
      import("./views.ts"),
      import("../../board/snapshot.ts"),
    ]);
    return {
      views: ternViewHost(commands, { clock, wait, guard, guardOpen }),
      projectForView,
      nativeViewsPath,
    };
  };
  return {
    name: "tern",
    openView: async (input) => (await native()).views.openView(input),
    closeView: async (input) => (await native()).views.closeView(input),
    // Loaded on use, as native() is, to keep native hosting out of every backend load.
    retainedViewOpens: async (home) => (await import("./host.ts")).listRetainedNativeOpens(home),
    abandonViewOpen: async (open, conclusive) =>
      (await import("./host.ts")).abandonRetainedNativeOpen(open, conclusive),
    recoverViewOpens: async (home) =>
      (await import("./host.ts")).recoverViewOpens(commands, home, clock()),
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
    close: (target) => closeWithNotification(target, false),
    closeOwned: (target) => closeWithNotification({ ...target, force: true }, true),
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
          terminal: "tern",
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
        await initializeShell(commands, {
          endpoint,
          cwd: target.cwd,
          ...(target.env === undefined ? {} : { env: target.env }),
        });
        let notificationPane: TerminalPaneLocation | undefined;
        if (target.role === "coordinator" && target.parentWorkspaceId === undefined) {
          try {
            notificationPane = await createNotificationPane(
              { endpoint, cwd: target.cwd },
              target.previousEndpoint,
            );
          } catch (cause) {
            if (cause instanceof TernOutcomeUnknownError) throw cause;
            throw new TernOutcomeUnknownError("tern alert helper verification", cause);
          }
        }
        return {
          endpoint: {
            ...endpoint,
            ...(notificationPane === undefined ? {} : { notificationPane }),
          },
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
          terminal: "tern",
          sessionId: anchor.sessionId,
          workspaceId: anchor.workspaceId,
          tabId: anchor.tabId,
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
        await initializeShell(commands, { endpoint, cwd: input.cwd });
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
        : focus({ endpoint: endpointFor(target, entry), cwd: target.cwd });
    },
    focusAgent: async (target) => {
      try {
        if (target.originCoordinator && target.home) {
          const cmd = await (await native()).views.scoped({
            coordinator: target.originCoordinator,
            cwd: target.cwd,
            home: target.home,
            view: { kind: "board" },
            ...(target.origin === undefined ? {} : { origin: target.origin }),
          });
          const entry = blocks(await cmd.ls(target.cwd)).find(
            (each) => each.block.id === target.paneId,
          );
          if (!entry) return false;
          const endpoint = endpointFor(target, entry);
          await guard(endpoint.paneId, () =>
            paneMutation(cmd, { endpoint, cwd: target.cwd }, ["focus", endpoint.paneId]),
          );
          return true;
        }
        return (await focus({ endpoint: await byId(target, target.paneId), cwd: target.cwd }))
          .focused;
      } catch {
        return false;
      }
    },
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
    checkInstall: async () => {
      const result = await probeTern(run, { binary: commands.binary, now: clock, sleep: wait });
      if (result.status === "unknown")
        return [{ name: "Tern", ok: false, detail: `readiness unknown: ${result.reason}` }];
      if (result.status === "ready") return [{ name: "Tern", ok: true, detail: "ready" }];
      if (result.status === "signedOut")
        return [
          {
            name: "Tern",
            ok: false,
            detail: "not signed in",
            fix: "Open Tern and sign in to your Stencil account.",
          },
        ];
      return [
        {
          name: "Tern",
          ok: false,
          detail: "not installed",
          fix: "Install Tern from https://stencil.so/tern",
        },
      ];
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
      if (inspected.activeWorker) throw new EndpointBusyError(endpoint);
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
    openWelcome: async (target) => {
      if (options.home === undefined) throw new Error("Tern welcome requires a Tandem home");
      const { views, projectForView, nativeViewsPath } = await native();
      const coordinator = await byId(target, target.paneId);
      const project = await projectForView(options.home, coordinator);
      await views.open(
        { coordinator, cwd: target.cwd, home: options.home, view: { kind: "board" } },
        project,
        "welcome",
        "split",
        nativeViewsPath(options.home, project),
      );
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
    openPanel: async (input) => {
      if (options.home === undefined) throw new Error("Tern panel requires a Tandem home");
      const { views, nativeViewsPath } = await native();
      return (
        await views.open(
          {
            coordinator: input.coordinator,
            cwd: input.cwd,
            home: options.home,
            view: { kind: "board" },
          },
          input.project,
          "panel",
          "panel",
          nativeViewsPath(options.home, input.project),
        )
      ).paneId;
    },
    isPanelOpen: async (input) => {
      const entry = blocks(await commands.ls(input.cwd)).find(
        (each) => each.block.id === input.panelPaneId,
      );
      return (
        entry !== undefined &&
        entry.session.id === input.coordinator.terminalSessionId &&
        entry.tab.id === input.coordinator.tabId &&
        entry.block.program === "tandem.panel" &&
        parseBlockArgs(entry.block.args)?.ctx.coordinator === input.coordinator.paneId
      );
    },
    closePanel: async (target) =>
      guard(target.panelPaneId, async () => {
        const listing = await commands.ls(target.cwd);
        if (listing.detached.length > 0)
          throw new TernOutcomeUnknownError("panel close", "detached placement is ambiguous");
        const entry = blocks(listing).find((each) => each.block.id === target.panelPaneId);
        if (entry === undefined) return;
        const endpoint = endpointFor(target, entry);
        if (options.home === undefined)
          throw new EndpointOwnershipError(endpoint, "panel close requires its recorded home");
        const { listCoordinatorRecords } = await import("../../coordinator/registry.ts");
        const { nativeViewsPath } = await import("../../board/snapshot.ts");
        const { exactView } = await import("./host.ts");
        const owners = (await listCoordinatorRecords(options.home, target.sessionId)).filter(
          (record) =>
            record.endpoint.terminal === "tern" &&
            record.endpoint.paneId !== entry.block.id &&
            record.endpoint.paneId === parseBlockArgs(entry.block.args)?.ctx.coordinator &&
            record.endpoint.terminalSessionId === entry.session.id &&
            record.endpoint.tabId === entry.tab.id &&
            record.endpoint.workspaceId === entry.tab.id &&
            record.worktree.path === target.cwd,
        );
        const owner = owners[0];
        if (owners.length !== 1 || owner === undefined)
          throw new EndpointOwnershipError(endpoint, "panel has no unique recorded coordinator");
        const path = nativeViewsPath(options.home, owner.repoPath);
        const args = blockArgs(path, {
          coordinator: owner.endpoint.paneId,
          cwd: target.cwd,
          home: options.home,
          index: path,
        });
        const proveIdentity = async () => {
          const current = await exactView(
            commands,
            target.cwd,
            owner.endpoint,
            "panel",
            "panel",
            args,
          );
          if (current?.block.id !== endpoint.paneId)
            throw new EndpointOwnershipError(endpoint, "pane is not the exact recorded panel");
        };
        await proveIdentity();
        const proc = await commands.read(target.cwd, ["process", endpoint.paneId], Processes);
        if (
          proc.pane !== endpoint.paneId ||
          proc.child !== null ||
          proc.foreground !== null ||
          proc.group !== null
        )
          throw new EndpointBusyError(endpoint);
        await proveIdentity();
        const ack = await commands.mutate(target.cwd, ["close", endpoint.paneId], BlockAck);
        if (ack.block !== endpoint.paneId)
          throw new TernOutcomeUnknownError("panel close", "acknowledged another block");
        try {
          const after = await commands.ls(target.cwd);
          if (
            after.detached.length > 0 ||
            blocks(after).some((each) => each.block.id === endpoint.paneId)
          )
            throw new Error("closed block is still present or detached placement is ambiguous");
        } catch (cause) {
          throw new TernOutcomeUnknownError("panel close", cause);
        }
      }),
    fitPanel: async (target) => ({
      fittedWidth: target.fittedWidth,
      warnings: ["Tern cannot resize panes; panel width is unchanged."],
    }),
    agentStatusReporter: () => undefined,
  };
}
