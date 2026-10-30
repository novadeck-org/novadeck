/**
 * Where `pnpm build:engine` leaves the engine for this platform: its archive, named by
 * `engine.json` beside it. The desktop app ships the manifest and passes its own paths.
 */
export declare const engineDirectory: string

/** The manifest `pnpm build:engine` writes: the archive's file name, SHA-256 and size. */
export declare const engineManifest: string
