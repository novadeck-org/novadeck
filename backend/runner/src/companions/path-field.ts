import { opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  companionLimits,
  folderMatchLimits,
  maxWroteFolders,
  type AgentName,
  type FolderMatch,
  type WroteFolder,
} from "@novadeck/protocol"

// What a terminal's folder tab's path field asks the runner: which folders a typed path may be,
// and which folders outside the project the session's agents wrote in.

/**
 * A path the person typed with a leading `~` (alone, or before a separator) read from their home
 * folder; any other path as it is.
 */
export const expandHome = (path: string, home: string = homedir()): string =>
  path === "~" || /^~[\\/]/.test(path) ? join(home, path.slice(1)) : path

/**
 * A path under the person's home folder written as `~/…`, as it is typed and shown; any other
 * path as it is.
 */
export const abbreviateHome = (path: string, home: string = homedir()): string => {
  const from = relative(home, path)
  if (from === "") return "~"
  if (from.startsWith("..") || isAbsolute(from)) return path
  return `~/${from.split(sep).join("/")}`
}

/** Whether `path` is `folder` or lies under it, by the paths as given. */
export const lies = (path: string, folder: string): boolean => {
  const from = relative(folder, path)
  return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

// How many entries a folder holds, counted up to `counted`; 0 for one that can't be read.
const countEntries = async (folder: string): Promise<number> => {
  let count = 0
  try {
    const directory = await opendir(folder)
    try {
      // eslint-disable-next-line no-await-in-loop -- Entries are read one at a time, up to the bound.
      while (count < folderMatchLimits.counted && (await directory.read()) !== null) count += 1
    } finally {
      await directory.close().catch(() => {})
    }
  } catch {
    return 0
  }
  return count
}

// The real path of a folder, or undefined where it isn't one or can't be reached.
const realFolder = async (path: string): Promise<string | undefined> => {
  try {
    const real = await realpath(path)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * The folders a typed path may be (see `companions.folders`): those in its parent whose names
 * start as its last part does, in any case, by name. `typed` is read from `cwd` where it is not
 * absolute; `secret` tells a folder that may hold secrets (see `folderSecrets`), which is never
 * named nor looked into; `shown` holds the real paths of the folders a folder item already
 * shows. A parent of more than `folderMatchLimits.scanned` entries is read as far as that.
 */
export const matchFolders = async (
  typed: string,
  cwd: string,
  secret: (path: string) => boolean,
  shown: ReadonlySet<string>,
): Promise<FolderMatch[]> => {
  if (typed.trim() === "") return []
  // "~" alone names the home folder's folders, as "~/" does.
  const text = typed === "~" ? "~/" : typed
  const last = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"))
  const before = text.slice(0, last + 1)
  const prefix = text.slice(last + 1).toLowerCase()
  const parent = await realFolder(resolve(cwd, expandHome(before === "" ? "." : before)))
  if (parent === undefined || secret(parent)) return []
  // A dot folder is named only by a path that starts one, as a shell completes.
  const hidden = prefix.startsWith(".")
  const names: { name: string; link: boolean }[] = []
  try {
    const directory = await opendir(parent)
    try {
      let scanned = 0
      for await (const entry of directory) {
        scanned += 1
        const link = entry.isSymbolicLink()
        if (
          (entry.isDirectory() || link) &&
          entry.name.toLowerCase().startsWith(prefix) &&
          (hidden || !entry.name.startsWith("."))
        )
          names.push({ name: entry.name, link })
        if (scanned >= folderMatchLimits.scanned) break
      }
    } finally {
      await directory.close().catch(() => {})
    }
  } catch {
    return []
  }
  names.sort((a, b) => a.name.localeCompare(b.name))
  const found: FolderMatch[] = []
  for (const { name } of names) {
    if (found.length >= folderMatchLimits.matches) break
    // A link is named only for a folder it leads to; any folder only if it may hold no secrets.
    // eslint-disable-next-line no-await-in-loop -- Only as many as are named are asked about.
    const real = await realFolder(join(parent, name))
    if (real === undefined || secret(real) || secret(join(parent, name))) continue
    // A name that would make a path the protocol can't carry is no match.
    if (before.length + name.length > companionLimits.path) continue
    found.push({ path: before + name, count: 0, open: shown.has(real) })
  }
  const counts = await Promise.all(
    found.map(({ path }) => countEntries(resolve(cwd, expandHome(path)))),
  )
  return found.map((match, at) => ({ ...match, count: counts[at]! }))
}

/** A session's write in a folder, as a terminal's place tells it. */
export type Wrote = {
  readonly folder: string
  readonly at: number
  readonly handle: string
  readonly agent: AgentName
  /** The folder the terminal that wrote it works in. */
  readonly cwd: string
}

/**
 * The folders outside the project the session's agents wrote in (see `companions.wroteTo`):
 * the latest first, once each, at most `maxWroteFolders`. A folder in the project or in the
 * folder its terminal works in, one in a harness's own home (`homes`: where it keeps its plans,
 * memory and conversation files), one that may hold secrets and one that is gone are left out.
 */
export const wroteFolders = async (
  wrote: readonly Wrote[],
  project: string | undefined,
  secret: (path: string) => boolean,
  homes: readonly string[] = [],
): Promise<WroteFolder[]> => {
  const realProject =
    project === undefined ? undefined : await realpath(project).catch(() => project)
  const seen = new Set<string>()
  const found: WroteFolder[] = []
  for (const each of wrote.toSorted((a, b) => b.at - a.at)) {
    if (found.length >= maxWroteFolders) break
    if (!isAbsolute(each.folder)) continue
    // eslint-disable-next-line no-await-in-loop -- The latest first, until enough are named.
    const real = await realFolder(each.folder)
    if (real === undefined || seen.has(real) || secret(real) || secret(each.folder)) continue
    seen.add(real)
    const inside = (folder: string) =>
      [project, realProject].some((top) => top !== undefined && lies(folder, top))
    if (inside(each.folder) || inside(real)) continue
    if (homes.some((home) => lies(each.folder, home) || lies(real, home))) continue
    // eslint-disable-next-line no-await-in-loop -- As the folder above.
    const own = await realpath(each.cwd).catch(() => each.cwd)
    if (lies(each.folder, each.cwd) || lies(real, own)) continue
    found.push({
      path: abbreviateHome(each.folder),
      handle: each.handle,
      agent: each.agent,
      at: each.at,
    })
  }
  return found
}
