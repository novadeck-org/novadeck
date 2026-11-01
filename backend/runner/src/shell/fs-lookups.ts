import { readdir, realpath, stat } from "node:fs/promises"

import type { FsLookups } from "@novadeck/harness-core/grants"

/** The longest the disk may take to answer one lookup; past it the call matches nothing. */
export const fsMs = 1_000

// The work's result, or undefined when it fails or takes longer than `fsMs`.
const capped = <T>(work: Promise<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), fsMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })

/**
 * What the matcher reads of the disk: a path's real path (symlinks followed) and whether it
 * is a regular file, and the names in a folder. An error or a timeout is undefined, and the
 * matcher then lets nothing through.
 */
export const fsLookups: FsLookups = {
  real: (path) =>
    capped(
      realpath(path).then(async (real) => ({ path: real, file: (await stat(real)).isFile() })),
    ),
  names: (path) =>
    capped(
      readdir(path).catch((error: NodeJS.ErrnoException) => {
        // Absent is an answer; any other failure is not.
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
        throw error
      }),
    ),
}
