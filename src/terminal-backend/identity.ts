import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type { Endpoint, TerminalName } from "../contracts.ts";
import type { TerminalBackend } from "./contract.ts";

/** Untagged records predate Tern support and were created exclusively by Herdr. */
export function storedEndpointTerminal(value: unknown, field: string): TerminalName {
  if (value === undefined) return "herdr";
  if (value === "herdr" || value === "tern") return value;
  throw new TypeError(`${field}.terminal must be "herdr" or "tern"`);
}

/** A foreign terminal's ids never reach a runner, even when the strings happen to match. */
export function assertTerminalEndpoint(terminal: TerminalName, endpoint: Endpoint): void {
  if (endpoint.terminal !== terminal) {
    throw new EndpointOwnershipError(
      endpoint,
      `quarantined ${endpoint.terminal} endpoint under ${terminal}; switch back to inspect it`,
    );
  }
}

declare const ternIdentity: unique symbol;
/** A Tern endpoint whose terminal tag was checked here. Tern mutations accept nothing else. */
export type TernEndpoint = Endpoint & Readonly<{ terminal: "tern"; [ternIdentity]: true }>;

export function ternEndpoint(endpoint: Endpoint): TernEndpoint {
  assertTerminalEndpoint("tern", endpoint);
  return endpoint as TernEndpoint;
}

/** Apply terminal ownership before every port operation that accepts a durable endpoint. */
export function guardTerminalIdentity(backend: TerminalBackend): TerminalBackend {
  const check = (endpoint: Endpoint) => assertTerminalEndpoint(backend.name, endpoint);
  return {
    ...backend,
    inspect: async (target) => {
      check(target.endpoint);
      return backend.inspect(target);
    },
    runCommand: async (target) => {
      check(target.endpoint);
      return backend.runCommand(target);
    },
    sendKeys: async (target) => {
      check(target.endpoint);
      return backend.sendKeys(target);
    },
    interrupt: async (target) => {
      check(target.endpoint);
      return backend.interrupt(target);
    },
    close: async (target) => {
      check(target.endpoint);
      return backend.close(target);
    },
    closeOwned: async (target) => {
      check(target.endpoint);
      return backend.closeOwned(target);
    },
    createWorkspace: async (target) => {
      if (target.previousEndpoint !== undefined) check(target.previousEndpoint);
      return backend.createWorkspace(target);
    },
    splitBeside: async (input) => {
      if ("anchor" in input) check(input.anchor);
      return backend.splitBeside(input);
    },
    openPanel: async (input) => {
      check(input.coordinator);
      return backend.openPanel(input);
    },
    isPanelOpen: async (input) => {
      check(input.coordinator);
      return backend.isPanelOpen(input);
    },
    closeView: async (input) => {
      check(input.coordinator);
      return backend.closeView(input);
    },
    openView: async (input) => {
      check(input.coordinator);
      return backend.openView(input);
    },
  };
}
