import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { basename, join } from "node:path"

import type { Sandbox } from "./sandbox.js"

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

// Windows' names are any case, as is how a program writes them; Linux's are one.
const folded = process.platform === "win32"
const fold = (text: string): string => (folded ? text.toLowerCase() : text)

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
const holds = (path: string, texts: readonly string[]): boolean => {
  try {
    const content = fold(readFileSync(path, "utf8"))
    return texts.some((text) => content.includes(fold(text)))
  } catch {
    return false
  }
}

// Each character past ASCII as JSON's `\uXXXX`, in either case of hex, as some programs
// write JSON.
const escaped = (text: string): readonly string[] =>
  [(hex: string) => hex, (hex: string) => hex.toUpperCase()].map((cased) =>
    text.replaceAll(
      /[\u0080-￿]/g,
      (character) => `\\u${cased(character.charCodeAt(0).toString(16).padStart(4, "0"))}`,
    ),
  )

/**
 * The ways a configuration file may write a path: as it is, as JSON or TOML escape it
 * (`C:\\Users\\…`, as Windows paths are written there), with each character past ASCII
 * as `\uXXXX` too, with forward slashes (`C:/Users/…`), and as MSYS writes one
 * (`/c/Users/…`), as some programs write a Windows path. On Linux all are the path
 * itself, or its escapes.
 */
export const spellings = (path: string): readonly string[] => {
  const json = JSON.stringify(path).slice(1, -1)
  const forward = path.replaceAll("\\", "/")
  const drive = /^([a-z]):\//i.exec(forward)
  return [
    ...new Set([
      path,
      json,
      ...escaped(json),
      forward,
      ...(drive ? [`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`] : []),
    ]),
  ]
}

/**
 * The path's 8.3 short name (`C:\Users\JANKOW~1\…`), as Windows keeps one on most volumes
 * and a program may write a path that would need quoting by it, or undefined
 * where it has none other than the path itself, or off Windows.
 */
export const shortName = (path: string): string | undefined => {
  if (!folded) return undefined
  // Verbatim, as Node would escape the inner quotes in a way cmd does not read; `/u`
  // prints UTF-16, which keeps a name past ASCII that a console code page would not.
  const { status, stdout } = spawnSync(
    process.env.COMSPEC || "cmd.exe",
    ["/d", "/u", "/s", "/c", `"for %A in ("${path}") do @echo %~sA"`],
    { windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000 },
  )
  if (status !== 0 || !stdout) return undefined
  const short = stdout.toString("utf16le").trim()
  return short !== "" && fold(short) !== fold(path) ? short : undefined
}

// Whether a folder has an entry whose name holds any of the texts.
const names = (path: string, texts: readonly string[]): boolean => {
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
  const user = home
  const watched = (kind: keyof Watch) =>
    watches.flatMap((watch) => watch[kind]).map((path) => join(user, path))
  const stamped = watched("stamped")
  const before = stamps(stamped)
  const roots = [sandbox.root, shortName(sandbox.root) ?? []].flat()
  const written = roots.flatMap(spellings)
  const own = [...new Set(roots.map((root) => basename(root)))]
  return () => {
    const changed = [...stamps(stamped)]
      .filter(([path, after]) => before.get(path) !== after)
      .map(([path]) => path)
    const mentioned = watched("searched").filter((path) => holds(path, written))
    const entries = watched("listed").filter((path) => names(path, own))
    return [...changed, ...mentioned, ...entries]
  }
}
