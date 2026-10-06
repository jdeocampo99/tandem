import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { z } from "zod";
import {
  AdapterError,
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../../adapters/primitives.ts";
import type { Endpoint, TerminalPaneLocation } from "../../contracts.ts";
import { blockArgs, parseBlockArgs } from "../../native/contract.ts";
import type { EndpointTarget, SessionTarget, TerminalBackend } from "../contract.ts";
import { type TernEndpoint, ternEndpoint } from "../identity.ts";
import {
  clearTernQuarantine,
  listTernQuarantine,
  missing,
  probeTern,
  type TernCli,
  type TernOptions,
  type TernRunner,
  ternCli,
} from "./cli.ts";
import {
  blocks,
  type Created,
  Id,
  isDaemonGone,
  type LocatedBlock,
  TernOutcomeUnknownError,
} from "./protocol.ts";

export type TernBackendOptions = TernOptions &
  Readonly<{
    /** Resolve only the recorded dedicated helper, including after a restart. */
    notificationEndpoint?: (target: SessionTarget) => Promise<Endpoint | undefined>;
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

/** Close one pane, then the native session its close emptied, which Tern otherwise keeps. */
async function closePane(
  cli: TernCli,
  target: Readonly<{ endpoint: TernEndpoint; cwd: string; force?: boolean; owned: boolean }>,
): Promise<void> {
  const closed = await cli.mutate({
    verb: "close",
    endpoint: target.endpoint,
    cwd: target.cwd,
    owned: target.owned,
    ...(target.force === undefined ? {} : { force: target.force }),
  });
  if (!closed.absent && closed.emptied !== undefined)
    await cli.mutate({
      verb: "killSession",
      cwd: target.cwd,
      session: closed.emptied,
      closed: target.endpoint,
    });
}

/** Tern's daemon is the port session; a Tern tab supplies both workspaceId and tabId. */
export function ternBackend(run: TernRunner, options: TernBackendOptions = {}): TerminalBackend {
  const cli = ternCli(run, options);
  const check = async (target: EndpointTarget) => {
    try {
      return await cli.inspect(target);
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
  const endpointFor = (target: SessionTarget, entry: LocatedBlock): TernEndpoint =>
    ternEndpoint({
      terminal: "tern",
      sessionId: target.sessionId,
      terminalSessionId: entry.session.id,
      workspaceId: entry.tab.id,
      tabId: entry.tab.id,
      paneId: entry.block.id,
      role: "coordinator",
      generation: 0,
    });
  const byId = async (target: SessionTarget, paneId: string): Promise<TernEndpoint> => {
    const found = blocks(await cli.ls(target.cwd)).find((entry) => entry.block.id === paneId);
    if (found === undefined)
      throw missing({
        terminal: "tern",
        sessionId: target.sessionId,
        workspaceId: "unknown",
        tabId: "unknown",
        paneId,
        role: "coordinator",
        generation: 0,
      });
    return endpointFor(target, found);
  };
  const rename = async (target: SessionTarget & { workspaceId: string; label: string }) => {
    const found = blocks(await cli.ls(target.cwd)).find(
      (entry) => entry.tab.id === target.workspaceId,
    );
    if (found === undefined) throw new AdapterError("exact Tern tab is absent", "tern rename");
    await cli.mutate({
      verb: "rename",
      endpoint: endpointFor(target, found),
      cwd: target.cwd,
      label: target.label,
    });
  };
  const focus = async (endpoint: TernEndpoint, cwd: string) => {
    try {
      await cli.mutate({ verb: "focus", endpoint, cwd });
      return { focused: true as const };
    } catch (error) {
      return { focused: false as const, code: 1, detail: String(error) };
    }
  };
  const createNotificationPane = async (
    owner: Readonly<{ endpoint: TernEndpoint; cwd: string }>,
    previous: Endpoint | undefined,
  ): Promise<TerminalPaneLocation> => {
    const stored =
      previous !== undefined && previous.terminalSessionId === owner.endpoint.terminalSessionId
        ? ternNotificationEndpoint(previous)
        : undefined;
    if (stored !== undefined) {
      try {
        await cli.exactPane({ endpoint: stored, cwd: owner.cwd });
        return { workspaceId: stored.workspaceId, tabId: stored.tabId, paneId: stored.paneId };
      } catch (error) {
        if (!(error instanceof EndpointOwnershipError && error.reason === "missing")) throw error;
      }
    }
    const placement = await cli.exactPane(owner);
    const created = await cli.mutate({
      verb: "newTab",
      cwd: owner.cwd,
      session: placement.session.id,
      beside: { endpoint: owner.endpoint },
    });
    const helper = ternEndpoint({
      terminal: "tern",
      sessionId: owner.endpoint.sessionId,
      terminalSessionId: created.session,
      workspaceId: created.tab,
      tabId: created.tab,
      paneId: created.block,
      role: "coordinator",
      generation: 0,
    });
    await cli.mutate({ verb: "run", endpoint: helper, cwd: owner.cwd, line: { export: {} } });
    await rename({
      sessionId: helper.sessionId,
      workspaceId: helper.workspaceId,
      cwd: owner.cwd,
      label: "Tandem alerts",
    });
    return { workspaceId: helper.workspaceId, tabId: helper.tabId, paneId: helper.paneId };
  };
  const closeWithNotification = async (
    target: EndpointTarget & Readonly<{ force?: boolean }>,
    strict: boolean,
  ) => {
    const endpoint = ternEndpoint(target.endpoint);
    const recordedHelper = ternNotificationEndpoint(endpoint);
    const helper = recordedHelper === undefined ? undefined : ternEndpoint(recordedHelper);
    if (helper !== undefined) {
      for (const each of [endpoint, helper]) {
        try {
          if (
            (await cli.inspect({ endpoint: each, cwd: target.cwd })).activeWorker &&
            !target.force
          )
            throw new EndpointBusyError(each);
        } catch (error) {
          if (
            !(error instanceof EndpointOwnershipError && error.reason === "missing") ||
            (strict && each === endpoint)
          )
            throw error;
        }
      }
    }
    const { planCoordinatorViews } = await import("./retire-views.ts");
    const retireViews = await planCoordinatorViews(cli, options.home, target);
    // Prove the conversation before retiring views, then recheck it in close itself.
    try {
      if ((await check(target)).activeWorker && target.force !== true)
        throw new EndpointBusyError(endpoint);
    } catch (error) {
      if (strict || !(error instanceof EndpointOwnershipError && error.reason === "missing"))
        throw error;
    }
    await closePane(cli, {
      endpoint,
      cwd: target.cwd,
      owned: strict,
      ...(target.force === undefined ? {} : { force: target.force }),
    });
    await retireViews();
    if (helper !== undefined)
      await closePane(cli, {
        endpoint: helper,
        cwd: target.cwd,
        owned: false,
        ...(target.force === undefined ? {} : { force: target.force }),
      });
  };
  // Native screens load coordinator/model code only when requested. Ordinary worker startup
  // must not load the interactive harness through this terminal port.
  const native = async () => {
    const [{ ternViewHost, projectForView }, { viewIndexPath }] = await Promise.all([
      import("./views.ts"),
      import("../../native/store.ts"),
    ]);
    return { views: ternViewHost(cli), projectForView, viewIndexPath };
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
      (await import("./host.ts")).recoverViewOpens(cli, home, cli.clock()),
    quarantinedPanes: listTernQuarantine,
    clearPaneQuarantine: clearTernQuarantine,
    inspect: check,
    runCommand: (target) =>
      cli.mutate({
        verb: "run",
        endpoint: ternEndpoint(target.endpoint),
        cwd: target.cwd,
        line: {
          command: target.command,
          ...(target.env === undefined ? {} : { env: target.env }),
        },
      }),
    sendKeys: (target) =>
      cli.mutate({
        verb: "send",
        endpoint: ternEndpoint(target.endpoint),
        cwd: target.cwd,
        input: { keys: target.keys },
      }),
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
      await cli.mutate({
        verb: "send",
        endpoint: ternEndpoint(target.endpoint),
        cwd: target.cwd,
        input: { keys: [target.key ?? "ctrl+c"] },
      });
      const deadline = cli.clock() + timeoutMs;
      while ((await check(target)).activeWorker) {
        if (cli.clock() >= deadline) throw new EndpointBusyError(target.endpoint);
        await cli.wait(pollIntervalMs);
      }
      return { wasRunning: true };
    },
    close: (target) => closeWithNotification(target, false),
    closeOwned: (target) => closeWithNotification({ ...target, force: true }, true),
    isPaneGone: (error) => error instanceof EndpointOwnershipError && error.reason === "missing",
    isEndpointGone: (error) =>
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      isDaemonGone(error),
    createWorkspace: async (target) => {
      let created: z.infer<typeof Created>;
      if (target.parentWorkspaceId !== undefined) {
        const parent = blocks(await cli.ls(target.cwd)).find(
          (entry) => entry.tab.id === target.parentWorkspaceId,
        );
        if (parent === undefined)
          throw new AdapterError("exact parent Tern tab is absent", "tern new tab");
        created = await cli.mutate({
          verb: "newTab",
          cwd: target.cwd,
          session: parent.session.id,
          beside: { tab: target.parentWorkspaceId },
        });
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
        const existing = await cli.ls(target.cwd);
        if (
          storedSession !== undefined &&
          existing.sessions.some((entry) => entry.id === storedSession)
        ) {
          // Never look up the old project by name; only the stored exact session id is reused.
          created = await cli.mutate({ verb: "newTab", cwd: target.cwd, session: storedSession });
        } else {
          const suffix = createHash("sha256")
            .update(`${target.sessionId}\0${target.cwd}`)
            .digest("hex")
            .slice(0, 12);
          const baseName = `tandem-${basename(target.cwd)}-${suffix}`;
          let name = baseName;
          let collision = 0;
          // Names prevent collisions only. Never adopt a pane or an empty retained session by title.
          while (existing.sessions.some((entry) => entry.name === name)) {
            collision += 1;
            name = `${baseName}-${collision}`;
          }
          created = await cli.mutate({ verb: "newSession", cwd: target.cwd, name });
        }
      }
      const endpoint = ternEndpoint({
        terminal: "tern",
        sessionId: target.sessionId,
        terminalSessionId: created.session,
        workspaceId: created.tab,
        tabId: created.tab,
        paneId: created.block,
        role: target.role,
        generation: target.generation,
      });
      await rename({ ...target, workspaceId: endpoint.workspaceId });
      await cli.mutate({
        verb: "run",
        endpoint,
        cwd: target.cwd,
        line: { export: target.env ?? {} },
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
    },
    splitBeside: async (input) => {
      const anchor = ternEndpoint(
        "anchor" in input ? input.anchor : await byId(input, input.anchorPaneId),
      );
      const created = await cli.mutate({ verb: "split", endpoint: anchor, cwd: input.cwd });
      const endpoint = ternEndpoint({
        terminal: "tern",
        sessionId: anchor.sessionId,
        workspaceId: anchor.workspaceId,
        tabId: anchor.tabId,
        terminalSessionId: created.session,
        paneId: created.block,
        role: input.role,
        generation: input.generation,
      });
      await cli.mutate({ verb: "run", endpoint, cwd: input.cwd, line: { export: {} } });
      return endpoint;
    },
    listWorkspaces: async (target) =>
      (await cli.ls(target.cwd)).sessions.flatMap((session) =>
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
      (await cli.ls(target.cwd)).sessions
        .flatMap((session) => session.tabs)
        .find((tab) => tab.id === target.workspaceId)?.name ?? undefined,
    renameWorkspace: rename,
    listPanes: async (target) =>
      blocks(await cli.ls(target.cwd))
        .filter((entry) => target.workspaceId === undefined || entry.tab.id === target.workspaceId)
        .map((entry) => ({
          paneId: entry.block.id,
          tabId: entry.tab.id,
          workspaceId: entry.tab.id,
          cwd: entry.block.cwd,
        })),
    snapshot: async (target) => {
      try {
        return blocks(await cli.ls(target.cwd)).map((entry) => ({
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
      const entry = blocks(await cli.ls(target.cwd)).find(
        (entry) => entry.tab.id === target.workspaceId,
      );
      return entry === undefined
        ? { focused: false, code: 1, detail: "exact Tern tab is absent" }
        : focus(endpointFor(target, entry), target.cwd);
    },
    focusAgent: async (target) => {
      try {
        if (target.originCoordinator && target.home) {
          const scoped = await (await native()).views.scoped({
            coordinator: target.originCoordinator,
            cwd: target.cwd,
            home: target.home,
            view: { kind: "board" },
            ...(target.origin === undefined ? {} : { origin: target.origin }),
          });
          const entry = blocks(await scoped.ls(target.cwd)).find(
            (each) => each.block.id === target.paneId,
          );
          if (!entry) return false;
          await scoped.mutate({
            verb: "focus",
            endpoint: endpointFor(target, entry),
            cwd: target.cwd,
          });
          return true;
        }
        return (await focus(await byId(target, target.paneId), target.cwd)).focused;
      } catch {
        return false;
      }
    },
    sessionRunning: async (target) => {
      try {
        await cli.ls(target.cwd);
        return true;
      } catch (error) {
        if (isDaemonGone(error)) return false;
        throw error;
      }
    },
    sessionDetail: async (target) => {
      const listing = await cli.ls(target.cwd);
      return `Tern daemon: ${listing.sessions.length} sessions`;
    },
    serverCommand: cli.serverCommand,
    clientCommand: cli.clientCommand,
    checkInstall: async () => {
      const result = await probeTern(run, { binary: cli.binary, now: cli.clock, sleep: cli.wait });
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
      await cli.mutate({
        verb: "notify",
        helper: ternEndpoint(endpoint),
        cwd: target.cwd,
        title: target.title,
        body: target.body,
      });
    },
    openWelcome: async (target) => {
      if (options.home === undefined) throw new Error("Tern welcome requires a Tandem home");
      const { views, projectForView, viewIndexPath } = await native();
      const coordinator = await byId(target, target.paneId);
      const project = await projectForView(options.home, coordinator);
      await views.open(
        { coordinator, cwd: target.cwd, home: options.home, view: { kind: "board" } },
        project,
        "welcome",
        "split",
        viewIndexPath(options.home, project),
      );
    },
    promptAgent: async (target) =>
      cli.mutate({
        verb: "send",
        endpoint: await byId(target, target.paneId),
        cwd: target.cwd,
        input: { text: `${target.text}\r` },
      }),
    openPanel: async (input) => {
      if (options.home === undefined) throw new Error("Tern panel requires a Tandem home");
      const { views, viewIndexPath } = await native();
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
          viewIndexPath(options.home, input.project),
        )
      ).paneId;
    },
    isPanelOpen: async (input) => {
      const entry = blocks(await cli.ls(input.cwd)).find(
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
    closePanel: async (target) => {
      const listing = await cli.ls(target.cwd);
      if (listing.detached.length > 0)
        throw new TernOutcomeUnknownError("panel close", "detached placement is ambiguous");
      const entry = blocks(listing).find((each) => each.block.id === target.panelPaneId);
      if (entry === undefined) return;
      const endpoint = endpointFor(target, entry);
      if (options.home === undefined)
        throw new EndpointOwnershipError(endpoint, "panel close requires its recorded home");
      const { listCoordinatorRecords } = await import("../../coordinator/registry.ts");
      const { viewIndexPath } = await import("../../native/store.ts");
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
      const path = viewIndexPath(options.home, owner.repoPath);
      const args = blockArgs(path, {
        coordinator: owner.endpoint.paneId,
        cwd: target.cwd,
        home: options.home,
        index: path,
      });
      const current = await exactView(cli, target.cwd, owner.endpoint, "panel", "panel", args);
      if (current?.block.id !== endpoint.paneId)
        throw new EndpointOwnershipError(endpoint, "pane is not the exact recorded panel");
      await cli.mutate({
        verb: "close",
        endpoint,
        cwd: target.cwd,
        view: { program: "tandem.panel", args },
      });
    },
    fitPanel: async (target) => ({
      fittedWidth: target.fittedWidth,
      warnings: ["Tern cannot resize panes; panel width is unchanged."],
    }),
    agentStatusReporter: () => undefined,
  };
}
