import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isNotFoundError } from "./storage.ts";
import { assertKnownKeys, isRecord, parseJson } from "./values.ts";

export type TandemBoundaryEnvironment = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId?: string;
  /**
   * The Herdr pane this process runs in, known only inside an active Herdr context whose session
   * is the Tandem session. Presentation placement only; it never grants ownership of that pane.
   */
  readonly coordinatorPaneId?: string;
  readonly poolRoot: string;
  readonly repo: string;
  readonly sourceRepo?: string;
}>;

export type TandemEnvironmentDefaults = Readonly<{
  readonly cwd: string;
  readonly sessionId?: string;
}>;

export type TandemEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type TandemEnvironmentContextOptions = Readonly<{
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
}>;

function readBoundaryText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL characters`);
  return value.trim();
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function readBoundaryPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty path`);
  }
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL characters`);
  if (hasPathControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return value;
}

function optionalBoundaryText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readBoundaryText(value, field);
}

type RememberedSetup = Readonly<{ home: string; sessionId: string }>;

function readRememberedSetup(source: TandemEnvironmentSource): RememberedSetup | undefined {
  const configRoot = readBoundaryPath(
    source.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "XDG_CONFIG_HOME",
  );
  if (!isAbsolute(configRoot)) throw new TypeError("XDG_CONFIG_HOME must be an absolute path");
  const path = join(configRoot, "tandem", "config.json");
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new TypeError(`${path} must be a regular file`);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  const value = parseJson(text, path);
  if (!isRecord(value)) throw new TypeError(`${path} must contain an object`);
  assertKnownKeys(value, { schemaVersion: true, home: true, sessionId: true }, path);
  if (value.schemaVersion !== 1) throw new TypeError(`${path} has an unsupported schemaVersion`);
  const home = readBoundaryPath(value.home, `${path} home`);
  if (!isAbsolute(home)) throw new TypeError(`${path} home must be an absolute path`);
  const sessionId = readBoundaryText(value.sessionId, `${path} sessionId`);
  if (hasPathControlCharacter(sessionId)) {
    throw new TypeError(`${path} sessionId must not contain control characters`);
  }
  return { home, sessionId };
}

export function processEnvironmentSnapshot(
  source: TandemEnvironmentSource | undefined,
): TandemEnvironmentSource {
  if (source !== undefined) return source;
  const values: Record<string, string | undefined> = {};
  for (const key of [
    "XDG_CONFIG_HOME",
    "TANDEM_HOME",
    "TANDEM_SESSION",
    "TANDEM_PARENT_WORKSPACE",
    "TANDEM_POOL_ROOT",
    "TANDEM_REPO",
    "TANDEM_SOURCE_REPO",
    "TANDEM_JEV_TIMEOUT_MS",
    "TYPESAFE_API_KEY",
    "HERDR_ENV",
    "HERDR_SESSION",
    "HERDR_SESSION_NAME",
    "HERDR_WORKSPACE_ID",
    "HERDR_PANE_ID",
  ]) {
    values[key] = process.env[key];
  }
  return values;
}

/**
 * The pane Herdr says this process runs in, only when Herdr is active and its session is the
 * Tandem session; a pane id from another session would name a pane Tandem cannot address.
 */
function herdrPaneInSession(
  source: TandemEnvironmentSource,
  sessionId: string,
): string | undefined {
  const active = source.HERDR_ENV?.trim().toLowerCase();
  if (active !== "1" && active !== "true") return undefined;
  const herdrSession = (source.HERDR_SESSION ?? source.HERDR_SESSION_NAME)?.trim();
  if (herdrSession !== sessionId) return undefined;
  const paneId = source.HERDR_PANE_ID?.trim();
  return paneId === undefined || paneId.length === 0 || paneId.includes("\0") ? undefined : paneId;
}

/** Resolve Tandem's process-boundary environment without leaking it into domain code. */
export function resolveTandemEnvironment(
  source: TandemEnvironmentSource,
  defaults: TandemEnvironmentDefaults,
  overrides: Partial<TandemBoundaryEnvironment> = {},
): TandemBoundaryEnvironment {
  const cwd = readBoundaryPath(defaults.cwd, "cwd");
  const explicitHome = overrides.home ?? source.TANDEM_HOME;
  // An explicitly selected home is a separate setup, not a change to the remembered one.
  const remembered = explicitHome === undefined ? readRememberedSetup(source) : undefined;
  const home = readBoundaryPath(
    explicitHome ?? remembered?.home ?? join(homedir(), ".tandem"),
    "TANDEM_HOME",
  );
  const sessionId = readBoundaryText(
    overrides.sessionId ??
      source.TANDEM_SESSION ??
      source.HERDR_SESSION ??
      source.HERDR_SESSION_NAME ??
      remembered?.sessionId ??
      defaults.sessionId ??
      "tandem",
    "TANDEM_SESSION",
  );
  const parentWorkspaceId = optionalBoundaryText(
    overrides.parentWorkspaceId ?? source.TANDEM_PARENT_WORKSPACE ?? source.HERDR_WORKSPACE_ID,
    "TANDEM_PARENT_WORKSPACE",
  );
  const coordinatorPaneId =
    overrides.coordinatorPaneId === undefined
      ? herdrPaneInSession(source, sessionId)
      : readBoundaryText(overrides.coordinatorPaneId, "coordinatorPaneId");
  const poolRoot = readBoundaryPath(
    overrides.poolRoot ?? source.TANDEM_POOL_ROOT ?? join(home, "pool"),
    "TANDEM_POOL_ROOT",
  );
  const repo = readBoundaryPath(overrides.repo ?? source.TANDEM_REPO ?? cwd, "TANDEM_REPO");
  const sourceRepoValue = overrides.sourceRepo ?? source.TANDEM_SOURCE_REPO;
  const sourceRepo =
    sourceRepoValue === undefined
      ? undefined
      : readBoundaryPath(sourceRepoValue, "TANDEM_SOURCE_REPO");
  return {
    home,
    sessionId,
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
    ...(coordinatorPaneId === undefined ? {} : { coordinatorPaneId }),
    poolRoot,
    repo,
    ...(sourceRepo === undefined ? {} : { sourceRepo }),
  };
}

export function environmentForContext(
  options: TandemEnvironmentContextOptions,
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): TandemBoundaryEnvironment {
  return resolveTandemEnvironment(
    processEnvironmentSnapshot(options.processEnvironment),
    { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
    {
      ...(options.environment?.home === undefined ? {} : { home: options.environment.home }),
      ...(options.environment?.sessionId === undefined
        ? {}
        : { sessionId: options.environment.sessionId }),
      ...(options.environment?.parentWorkspaceId === undefined
        ? {}
        : { parentWorkspaceId: options.environment.parentWorkspaceId }),
      ...(options.environment?.coordinatorPaneId === undefined
        ? {}
        : { coordinatorPaneId: options.environment.coordinatorPaneId }),
      ...(options.environment?.poolRoot === undefined
        ? {}
        : { poolRoot: options.environment.poolRoot }),
      ...(options.environment?.repo === undefined ? {} : { repo: options.environment.repo }),
      ...(options.environment?.sourceRepo === undefined
        ? {}
        : { sourceRepo: options.environment.sourceRepo }),
    },
  );
}

export function coordinatorSourceGuidance(environment: TandemBoundaryEnvironment): string {
  const boundary =
    environment.sourceRepo === undefined
      ? `Tandem has no dedicated clean source binding; ${JSON.stringify(environment.repo)} is the original project identity and source checkout.`
      : [
          `Tandem's clean committed coordinator checkout is ${JSON.stringify(environment.sourceRepo)} and is the current committed source scope for repository reads and delegated work.`,
          `The original project identity is ${JSON.stringify(environment.repo)}; pass that identity when creating tasks so records, policy, and delivery remain attached to the original project.`,
          "Do not edit or read delegated-work guidance from the original project checkout; it is identity only, not the execution source.",
        ].join(" ");
  return `${boundary} Source refresh happens only at the start of a new coordinator turn. Existing tasks and worker checkouts remain pinned to their captured commits; refresh may make earlier file observations stale.`;
}
