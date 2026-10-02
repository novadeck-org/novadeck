import { readdirSync, readFileSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { basename, join } from "node:path"

import type { AgentSetup } from "./agents/agent.js"
import type { Sandbox } from "./sandbox.js"

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

// Whether the file holds the text; an absent or unreadable file holds nothing.
const holds = (path: string, text: string): boolean => {
  try {
    return readFileSync(path, "utf8").includes(text)
  } catch {
    return false
  }
}

// Whether a folder has an entry whose name holds the text.
const names = (path: string, text: string): boolean => {
  try {
    return readdirSync(path).some((name) => name.includes(text))
  } catch {
    return false
  }
}

/**
 * A tripwire over the developer's real harness homes, watching what each setup lists
 * (`AgentSetup.watch`): call it before a test, and call what it returns after, for the
 * paths a harness that escaped the sandbox wrote to. Those are the configuration files
 * that now mention the sandbox's root, the folders with an entry named after the sandbox,
 * and the stamped paths whose time or size changed, or that appeared or went. Only paths
 * are returned, never anything read. A path absent both times, as all are in CI, is
 * skipped. A test watches every harness's paths, not only its own, as any harness that
 * escaped would be a leak.
 */
export const tripwire = (
  sandbox: Pick<Sandbox, "root">,
  setups: readonly Pick<AgentSetup, "watch">[],
): (() => readonly string[]) => {
  const user = userInfo().homedir
  const watched = (kind: keyof AgentSetup["watch"]) =>
    setups.flatMap((setup) => setup.watch[kind]).map((path) => join(user, path))
  const stamped = watched("stamped")
  const before = stamps(stamped)
  const own = basename(sandbox.root)
  return () => {
    const changed = [...stamps(stamped)]
      .filter(([path, after]) => before.get(path) !== after)
      .map(([path]) => path)
    const mentioned = watched("searched").filter((path) => holds(path, sandbox.root))
    const entries = watched("listed").filter((path) => names(path, own))
    return [...changed, ...mentioned, ...entries]
  }
}
