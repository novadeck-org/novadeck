import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"

import { createSandbox, type Sandbox } from "@novadeck/sandbox"
import { reap } from "@novadeck/sandbox/reap"
import { tripwire } from "@novadeck/sandbox/tripwire"

// The sandbox the benchmark's runs run Novadeck in, with the fake agent (agent.ts) first on
// its PATH as `claude`, the tripwire set over the developer's home, and the files that turn
// each agent busy or idle. Whatever starts Novadeck gives it the sandbox's environment alone,
// so the Novadeck `claude` shim, which runs the next `claude` on PATH, can only ever reach
// the fake. The runner's harness lookups read PATH again from a login shell (`$SHELL
// -ilc env`), where the system's profile may put its own folders first (macOS's path_helper
// does); none of those lookups runs in these scenarios, which connect nothing.

// The agent CLIs a folder on the sandbox's PATH may not hold, besides the fake's own.
const agents = ["claude", "codex", "agy"]

/**
 * The real agent CLIs in the folders of `path` but its first, the fake's own: the sandbox
 * refuses to start while there are any.
 */
export const strays = (path: string): readonly string[] =>
  path
    .split(delimiter)
    .slice(1)
    .flatMap((folder) => agents.map((agent) => join(folder, agent)))
    .filter((file) => existsSync(file))

/** A word sh reads as the text itself, whatever it holds. */
export const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

export type BenchSandbox = {
  readonly sandbox: Sandbox
  /** Turns agent `seed` busy or idle (see agent.ts). */
  readonly busy: (seed: number, on: boolean) => void
  /** The shell command that starts agent `seed`. */
  readonly agent: (seed: number) => string
  /**
   * Reaps whatever still runs in the sandbox, checks the developer's home and removes the
   * sandbox; call once what started in it has stopped. Returns what went wrong: processes
   * it had to end, and the developer's home written to from inside it.
   */
  readonly close: () => Promise<readonly string[]>
}

/** A fresh sandbox named `prefix<random>`; nothing runs in it yet. */
export const openSandbox = (prefix: string): BenchSandbox => {
  const base = createSandbox({ prefix, bins: [], user: "novadeck" })
  try {
    const bin = join(base.root, "bin")
    mkdirSync(bin, { mode: 0o700 })
    const claude = join(bin, "claude")
    writeFileSync(
      claude,
      `#!/bin/sh\nexec node ${quoted(join(import.meta.dirname, "agent.ts"))} "$@"\n`,
    )
    chmodSync(claude, 0o755)
    const path = [bin, base.env.PATH].join(delimiter)
    const found = strays(path)
    if (found.length > 0)
      throw new Error(`the sandbox's PATH holds a real agent CLI: ${found.join(", ")}`)
    // The runner counts Claude Code connected once Novadeck's plugin is on in its settings.
    mkdirSync(join(base.home, ".claude"), { recursive: true })
    writeFileSync(
      join(base.home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "novadeck@novadeck": true } }),
    )
    const control = join(base.root, "control")
    mkdirSync(control)
    const sandbox = { ...base, env: { ...base.env, PATH: path } }
    const changed = tripwire(sandbox, [
      {
        searched: [".claude.json", join(".claude", "settings.json")],
        listed: [join(".claude", "projects")],
        stamped: [join(".local", "share", "novadeck")],
      },
    ])
    return {
      sandbox,
      busy: (seed, on) => writeFileSync(join(control, String(seed)), on ? "on" : "off"),
      agent: (seed) =>
        `TIMING_AGENT_CONTROL=${quoted(join(control, String(seed)))} TIMING_AGENT_SEED=${seed} claude`,
      close: async () => {
        const leftovers = await reap(sandbox).catch((error: unknown) => [
          `reaping failed: ${String(error)}`,
        ])
        const written = (() => {
          try {
            return changed().map((file) => `the developer's home changed: ${file}`)
          } catch (error) {
            return [`the developer's home couldn't be checked: ${String(error)}`]
          }
        })()
        rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5 })
        return [
          ...leftovers.map((one) => `a process outlived the run in the sandbox: ${one}`),
          ...written,
        ]
      },
    }
  } catch (error) {
    rmSync(base.root, { recursive: true, force: true })
    throw error
  }
}
