import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { download, DownloadError, locate } from "./download.js"
import type { Manifest } from "./manifest.js"
import { engineFolder, exists, olderEngine, unpack } from "./unpack.js"

/** Whether `error` is an abort: cancelling is the person's choice, not a failure. */
export const aborted = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

/** Where the engine of `manifest` is unpacked under `directory`, and whether it is there. */
export const engineStatus = async (
  directory: string,
  manifest: Manifest | undefined,
  program: string,
): Promise<{ ready: boolean; folder: string | undefined }> => {
  if (manifest === undefined) return { ready: false, folder: undefined }
  const current = engineFolder(directory, manifest.sha256)
  if (await exists(join(current, program))) return { ready: true, folder: current }
  // An engine of an earlier build that still runs serves in the meantime.
  return { ready: false, folder: await olderEngine(directory, program, manifest.interface) }
}

/**
 * Downloads the engine's archive from `source` and unpacks it, which removes the engines
 * it replaces. `replacing` runs between the two: stop anything using those engines then.
 */
export const fetchEngine = async (options: {
  manifest: Manifest
  /**
   * Where the archive is: an https URL ending in `/`, or a folder; `undefined`, or empty as
   * a packaged build that knows no release passes it, when this build has none.
   */
  source: string | undefined
  directory: string
  program: string
  signal: AbortSignal
  progress: (received: number) => void
  replacing: () => Promise<void>
}): Promise<void> => {
  const { manifest, source, directory, signal } = options
  if (!source) throw new DownloadError("This build has nowhere to download the engine from.")
  const archive = join(directory, "downloads", manifest.file)
  await download({
    from: locate(source, manifest.file),
    to: archive,
    sha256: manifest.sha256,
    size: manifest.size,
    signal,
    progress: options.progress,
  })
  await options.replacing()
  await unpack(archive, directory, manifest.sha256, manifest.interface, options.program, signal)
  await rm(archive, { force: true })
}

/** Removes everything in `directory` but the entries named in `keep`; the folder itself may be one the person chose. */
export const removeContents = async (
  directory: string,
  keep: readonly string[] = [],
): Promise<void> => {
  const entries = await readdir(directory).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => !keep.includes(entry))
      .map((entry) => rm(join(directory, entry), { recursive: true, force: true })),
  )
}
