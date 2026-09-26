import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Tandem checkout this code runs from. Its coordinator, the Tandem coordinator, opens on every
 * plain `tandem`, onboards other repositories, and changes Tandem itself through tasks.
 */
export const TANDEM_CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Whether a project root is the Tandem checkout; a missing path is not. */
export async function isTandemCheckout(
  repoPath: string,
  tandemCheckout: string = TANDEM_CHECKOUT,
): Promise<boolean> {
  const [project, checkout] = await Promise.all([
    realpath(repoPath).catch(() => undefined),
    realpath(tandemCheckout).catch(() => undefined),
  ]);
  return project !== undefined && project === checkout;
}
