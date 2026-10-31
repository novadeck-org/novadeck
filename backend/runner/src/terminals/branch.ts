import { readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { cut } from "../text.js"

/** How long a branch is read for before it counts as unknown, in milliseconds. */
const readMs = 300

/**
 * The nearest folder at or above a directory holding `.git` (a folder, or a file naming
 * one, as a worktree's does): the top of its checkout, and what its `.git` is.
 */
const nearestGit = async (
  directory: string,
): Promise<{ readonly top: string; readonly dot: string; readonly file: boolean } | undefined> => {
  let current = directory
  for (let step = 0; step < 64; step += 1) {
    const dot = join(current, ".git")
    // eslint-disable-next-line no-await-in-loop -- Each folder up is looked at in turn.
    const found = await stat(dot).catch(() => undefined)
    if (found?.isDirectory() || found?.isFile()) return { top: current, dot, file: found.isFile() }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * The git checkout's folder holding `HEAD` for a directory: the nearest `.git` above it,
 * a folder, or a file naming one, as a worktree's does.
 */
const gitFolder = async (directory: string): Promise<string | undefined> => {
  const near = await nearestGit(directory)
  if (!near?.file) return near?.dot
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(near.dot, "utf8"))?.[1]?.trim()
  if (!pointer) return undefined
  return isAbsolute(pointer) ? pointer : resolve(near.top, pointer)
}

const branchOf = async (directory: string): Promise<string | null> => {
  const folder = await gitFolder(directory)
  if (!folder) return null
  const head = (await readFile(join(folder, "HEAD"), "utf8")).trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]
  if (ref) return cut(ref, 200)
  // Detached: its commit, shortened as git does.
  return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : null
}

/** What `read` gives, or null when it fails or takes longer than `readMs`. */
const quickly = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
  const timeout = new AbortController()
  try {
    return await Promise.race([
      read().catch(() => null),
      sleep(readMs, null, { signal: timeout.signal }),
    ])
  } catch {
    return null
  } finally {
    timeout.abort()
  }
}

/**
 * The git branch checked out in a directory, read from git's own files rather than by
 * running git; null outside a checkout, or when that takes longer than a moment.
 */
export const gitBranch = (directory: string): Promise<string | null> =>
  quickly(() => branchOf(directory))

/**
 * The top folder of the git checkout a directory is in, a worktree's own, found by git's
 * files rather than by running git; null outside one, for a folder that is gone, or when
 * that takes longer than a moment.
 */
export const gitCheckout = (directory: string): Promise<string | null> =>
  quickly(async () => (await nearestGit(directory))?.top ?? null)
