import { open, readdir, realpath, stat } from "node:fs/promises"
import { basename } from "node:path"

import { rolloutWorkdir, type FsLookups } from "@novadeck/harness-core/grants"

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

// The most of a rollout's end read for a call: the call is among its latest lines.
const rolloutTail = 8 * 1024 * 1024

// Codex's rollouts are `rollout-<time>-<session>.jsonl`; no other file is read for a call.
const isRollout = (path: string): boolean => /^rollout-.+\.jsonl$/.test(basename(path))

const tail = async (path: string): Promise<string> => {
  const file = await open(path, "r")
  try {
    const { size } = await file.stat()
    const length = Math.min(size, rolloutTail)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } finally {
    await file.close()
  }
}

/**
 * What the matcher reads of the disk: a path's real path (symlinks followed) and whether it
 * is a regular file, the names in a folder, and the folder a Codex call runs in. An error or a timeout is undefined, and the
 * matcher then lets nothing through.
 */
export const fsLookups: FsLookups = {
  real: (path) =>
    capped(
      realpath(path).then(async (real) => ({ path: real, file: (await stat(real)).isFile() })),
    ),
  workdir: ({ path, turn }, command) =>
    isRollout(path)
      ? capped(tail(path).then((text) => rolloutWorkdir(text, turn, command)))
      : Promise.resolve(undefined),
  names: (path) =>
    capped(
      readdir(path).catch((error: NodeJS.ErrnoException) => {
        // Absent is an answer; any other failure is not.
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
        throw error
      }),
    ),
}
