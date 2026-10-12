import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Where `pnpm build:engine` leaves the engine for this platform: its archive, named by
 * `engine.json` beside it. The desktop app ships the manifest and passes its own paths.
 */
export const engineDirectory = join(dirname(fileURLToPath(import.meta.url)), "dist")

/** The manifest `pnpm build:engine` writes: the archive's file name, SHA-256 and size. */
export const engineManifest = join(engineDirectory, "engine.json")
