import { readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/** How long a branch is read for before it counts as unknown, in milliseconds. */
const readMs = 300

/**
 * The git checkout's folder holding `HEAD` for a directory: the nearest `.git` above it,
 * a folder, or a file naming one, as a worktree's does.
 */
const gitFolder = async (directory: string): Promise<string | undefined> => {
  let current = directory
  for (let step = 0; step < 64; step += 1) {
    const candidate = join(current, ".git")
    // eslint-disable-next-line no-await-in-loop -- Each folder up is looked at in turn.
    const found = await stat(candidate).catch(() => undefined)
    if (found?.isDirectory()) return candidate
    if (found?.isFile()) {
      // eslint-disable-next-line no-await-in-loop -- As above.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, "utf8"))?.[1]?.trim()
      if (!pointer) return undefined
      return isAbsolute(pointer) ? pointer : resolve(current, pointer)
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

const branchOf = async (directory: string): Promise<string | null> => {
  const folder = await gitFolder(directory)
  if (!folder) return null
  const head = (await readFile(join(folder, "HEAD"), "utf8")).trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]
  if (ref) return ref.slice(0, 200)
  // Detached: its commit, shortened as git does.
  return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : null
}

/**
 * The git branch checked out in a directory, read from git's own files rather than by
 * running git; null outside a checkout, or when that takes longer than a moment.
 */
export const gitBranch = async (directory: string): Promise<string | null> => {
  const timeout = new AbortController()
  try {
    return await Promise.race([
      branchOf(directory).catch(() => null),
      sleep(readMs, null, { signal: timeout.signal }),
    ])
  } catch {
    return null
  } finally {
    timeout.abort()
  }
}
