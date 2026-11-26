import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { download } from "../engines/download.js"
import { buildFor, pinnedPi } from "../harnesses/bundled-pi.js"
import { cacheFolder, type Installed } from "./install.js"

// Novadeck's own pi (harnesses/bundled-pi.ts) is not installed from npm: the runner downloads the
// pinned release's archive and its licence as the tour starts. The e2e runs that offline, from a
// copy kept in the e2e cache, which the runner reads as it would a mirror
// (`NOVADECK_BUNDLED_PI_SOURCE` and `NOVADECK_BUNDLED_PI_LICENCE`): the files are fetched once per
// cache from the release the pins name, by the same checks the runner makes.

/** What a setup of Novadeck's own pi is "installed" as: no program of its own, the pinned version. */
export const ownInstalled: Installed = { bin: "", version: pinnedPi.version }

// The copies in this process, so one file's tests share one download.
let cached: Promise<{ readonly source: string; readonly licence: string }> | undefined

// Saves what is at `from` as `to`, unless it is there: `download` renames a file into place once it
// hashes right, so one that is there is whole, and the runner checks the same sums again as it
// unpacks from it.
const fetched = async (from: string, to: string, sha256: string, size: number): Promise<void> => {
  if (existsSync(to)) return
  await download({
    from,
    to,
    sha256,
    size,
    signal: new AbortController().signal,
    progress: () => {},
  })
}

const fetchCopy = async (): Promise<{ readonly source: string; readonly licence: string }> => {
  const build = buildFor(process.platform, process.arch)
  if (!build)
    throw new Error(`pi has no build for ${process.platform}-${process.arch}: no tour e2e here`)
  const source = join(cacheFolder(), `bundled-pi-${pinnedPi.version}`)
  const licence = join(source, "LICENSE")
  await mkdir(source, { recursive: true })
  await fetched(pinnedPi.licence.url, licence, pinnedPi.licence.sha256, pinnedPi.licence.size)
  await fetched(
    new URL(encodeURIComponent(build.file), pinnedPi.source).href,
    join(source, build.file),
    build.sha256,
    build.size,
  )
  return { source, licence }
}

/**
 * Fills the e2e cache with this system's archive of the pinned pi and its licence, as
 * `ownPiFromCache` would: for the install step that runs with the network (own-pi-fill.ts), the
 * suite then running without.
 */
export const fillOwnPiCache = (): Promise<{ readonly source: string; readonly licence: string }> =>
  fetchCopy()

/**
 * Downloads, once per e2e cache, this system's archive of the pinned pi and its licence
 * (`pinnedPi`), checked against their checksums, and points the runner at them: the folder holding
 * them is the archives' source and the file the licence. Returns what puts the two variables back
 * as they were.
 */
export const ownPiFromCache = async (): Promise<() => void> => {
  cached ??= fetchCopy()
  const { source, licence } = await cached.catch((error: unknown) => {
    cached = undefined
    throw error
  })
  const before = {
    source: process.env.NOVADECK_BUNDLED_PI_SOURCE,
    licence: process.env.NOVADECK_BUNDLED_PI_LICENCE,
  }
  process.env.NOVADECK_BUNDLED_PI_SOURCE = source
  process.env.NOVADECK_BUNDLED_PI_LICENCE = licence
  return () => {
    for (const [name, value] of [
      ["NOVADECK_BUNDLED_PI_SOURCE", before.source],
      ["NOVADECK_BUNDLED_PI_LICENCE", before.licence],
    ] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  }
}
