import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The relay's file name on this platform. */
export const relayName = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"

/**
 * The relay this package built for this platform, by `pnpm build`. Bundled, as into the
 * desktop app, this names a file beside the bundle that isn't there: the app passes the
 * relay it ships instead.
 */
export const relayPath = join(dirname(fileURLToPath(import.meta.url)), "dist", relayName)

/** The cmd.exe pass-through's file name, built on Windows alone. */
export const cmdShimName = "novadeck-cmd.exe"

/** The pass-through this package built, by `pnpm build`, on Windows. */
export const cmdShimPath = join(dirname(fileURLToPath(import.meta.url)), "dist", cmdShimName)
