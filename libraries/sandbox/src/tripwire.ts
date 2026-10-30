import { readdirSync, readFileSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { basename, join } from "node:path"

import type { Sandbox } from "./sandbox.js"
import { fold, shortName, spellings } from "./tripwire/spellings.js"

/**
 * What a tripwire watches in the developer's home, each path relative to it. `searched` are
 * configuration files a program rewrites as it runs, read and searched only for the
 * sandbox's root, which only a program that escaped the sandbox would write there.
 * `listed` are folders whose entries' names are searched for the sandbox's name. `stamped`
 * are paths whose modification time and size alone are compared, never their contents, as
 * a login, which is never read.
 */
export type Watch = {
  readonly searched: readonly string[]
  readonly listed: readonly string[]
  readonly stamped: readonly string[]
}

// A path's modification time and size, or nothing when it's absent.
const stamp = (path: string): string | undefined => {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

const stamps = (paths: readonly string[]): ReadonlyMap<string, string | undefined> =>
  new Map(paths.map((path) => [path, stamp(path)]))

// Whether the file holds any of the texts; an absent or unreadable file holds nothing.
const fileHolds = (path: string, texts: readonly string[]): boolean => {
  try {
    const content = fold(readFileSync(path, "utf8"))
    return texts.some((text) => content.includes(fold(text)))
  } catch {
    return false
  }
}

// Whether a folder has an entry whose name holds any of the texts.
const folderHolds = (path: string, texts: readonly string[]): boolean => {
  try {
    return readdirSync(path).some((name) => texts.some((text) => fold(name).includes(fold(text))))
  } catch {
    return false
  }
}

/**
 * A tripwire over the developer's real home, watching what each of `watches` lists: call it
 * before a run, and call what it returns after, for the paths a program that escaped the
 * sandbox wrote to. Those are the configuration files that now mention the sandbox's root,
 * by its name or its short name (see `spellings`), any case on Windows; the folders with an
 * entry named after the sandbox; and the stamped paths whose time or size changed, or that
 * appeared or went. Only paths are returned, never anything read. A path absent both times,
 * as all are in CI, is skipped. `home` is the developer's own unless a test gives another.
 */
export const tripwire = (
  sandbox: Pick<Sandbox, "root">,
  watches: readonly Watch[],
  home: string = userInfo().homedir,
): (() => readonly string[]) => {
  const watched = (kind: keyof Watch) =>
    watches.flatMap((watch) => watch[kind]).map((path) => join(home, path))
  const stamped = watched("stamped")
  const before = stamps(stamped)
  const roots = [sandbox.root, shortName(sandbox.root) ?? []].flat()
  const written = roots.flatMap(spellings)
  const own = [...new Set(roots.map((root) => basename(root)))]
  return () => {
    const changed = [...stamps(stamped)]
      .filter(([path, after]) => before.get(path) !== after)
      .map(([path]) => path)
    const mentioned = watched("searched").filter((path) => fileHolds(path, written))
    const entries = watched("listed").filter((path) => folderHolds(path, own))
    return [...changed, ...mentioned, ...entries]
  }
}
