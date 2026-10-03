import { createHash } from "node:crypto";
import { join } from "node:path";

/** macOS limits a unix socket path to 104 bytes, including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/** One short socket per session under the home; the session id is hashed to keep it short. */
export function sidecarSocketPath(home: string, sessionId: string): string {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const path = join(home, "sidecars", `${name}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `the sidecar socket path ${path} is longer than the ${MAX_SOCKET_PATH_BYTES} bytes macOS allows; use a shorter Tandem home`,
    );
  }
  return path;
}
