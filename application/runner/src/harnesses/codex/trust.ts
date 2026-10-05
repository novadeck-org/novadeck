import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import type { Install } from "../harness.js"

/** Novadeck's plugin, as Codex names the plugin a hook comes from. */
const pluginId = "novadeck@novadeck"

/**
 * The hooks without which nothing reaches a Codex session: SessionStart binds it, and the
 * prompt's and Stop's hooks deliver and confirm a ring.
 */
const needed = ["sessionStart", "userPromptSubmit", "stop"] as const

type Hook = {
  readonly pluginId?: unknown
  readonly eventName?: unknown
  readonly trustStatus?: unknown
}

/**
 * Whether the app-server's `hooks/list` result says Novadeck's hooks run: each one it
 * needs is listed from Novadeck's plugin, and every such one is `trusted` (not
 * `untrusted`, nor `modified` since the person trusted it).
 */
export const trustedIn = (result: unknown): boolean => {
  const data = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return false
  const hooks = data.flatMap((entry) =>
    Array.isArray((entry as { hooks?: unknown } | null)?.hooks)
      ? ((entry as { hooks: Hook[] }).hooks ?? [])
      : [],
  )
  const ours = hooks.filter((hook) => hook.pluginId === pluginId)
  return needed.every((event) => {
    const listed = ours.filter((hook) => hook.eventName === event)
    return listed.length > 0 && listed.every((hook) => hook.trustStatus === "trusted")
  })
}

/**
 * Where to ask Codex: the program and environment of the Codex in the terminal, where the
 * runner can tell them, else as the person's login would run it.
 */
export type Asking = Install & { readonly program?: string }

/** Asks Codex's app-server which hooks run in `cwd`, as its `hooks/list` reports them. */
const listHooks = (where: Asking, cwd: string, timeoutMs: number): Promise<unknown> =>
  new Promise((resolve) => {
    const program = where.program ?? "codex"
    const child =
      where.platform === "win32"
        ? spawn(where.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `""${program}" app-server"`], {
            env: where.env,
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
            windowsVerbatimArguments: true,
          })
        : spawn(program, ["app-server"], { env: where.env, stdio: ["pipe", "pipe", "ignore"] })
    let buffered = ""
    const done = (value: unknown) => {
      clearTimeout(timer)
      child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), timeoutMs)
    child.on("error", () => done(undefined))
    child.on("close", () => done(undefined))
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk
      let end = buffered.indexOf("\n")
      while (end >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf("\n")
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown }
          if (message.id === 2) return done(message.result)
        } catch {
          // Not JSON: something else it printed.
        }
      }
    })
    child.stdin.on("error", () => {})
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "novadeck", version: "1" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } },
    ])
      child.stdin.write(`${JSON.stringify(message)}\n`)
  })

// When a file last changed; 0 when it isn't there.
const changed = (path: string): Promise<number> =>
  stat(path).then(
    (file) => file.mtimeMs,
    () => 0,
  )

/**
 * What trust depends on, as it changes: Codex's `config.toml`, which records it, and the
 * hook definitions of Novadeck's plugin, as Codex keeps them in its plugin cache, which a
 * plugin's reinstall rewrites (and which then reads "modified").
 */
const stateOf = async (home: string): Promise<string> => {
  const cache = join(home, "plugins", "cache", "novadeck", "novadeck")
  const versions = await readdir(cache).catch(() => [] as string[])
  const hooks = await Promise.all(
    versions.toSorted().map(async (version) => {
      const path = join(cache, version, "hooks", "hooks.json")
      return `${version}:${await changed(path)}`
    }),
  )
  return [await changed(join(home, "config.toml")), ...hooks].join("|")
}

/** How long an answer Codex couldn't give is kept before it is asked again, in milliseconds. */
export const failureMs = 60_000

type Known = {
  readonly state: string
  readonly trusted: boolean | undefined
  readonly failedAt?: number
}
const known = new Map<string, Known>()
const asking = new Map<string, Promise<boolean | undefined>>()

/**
 * Whether Novadeck's Codex hooks run in `cwd`: Codex runs a plugin's hooks only once the
 * person trusts them, and no hook says when it doesn't, so its app-server is asked. The
 * answer is kept until Codex's configuration or Novadeck's hook definitions change.
 * Undefined when Codex couldn't answer (it couldn't start, or didn't answer within 10 s),
 * which is asked again only a minute later: unknown, never taken for untrusted. Asks
 * under way are shared.
 */
export const hooksTrusted = async (where: Asking, cwd: string): Promise<boolean | undefined> => {
  const home = where.env.CODEX_HOME || join(where.home, ".codex")
  const key = `${where.program ?? "codex"}\0${home}\0${cwd}`
  const state = await stateOf(home)
  const kept = known.get(key)
  if (
    kept?.state === state &&
    (kept.failedAt === undefined || Date.now() - kept.failedAt < failureMs)
  )
    return kept.trusted
  const pending = asking.get(key)
  if (pending) return pending
  const ask = listHooks(where, cwd, 10_000).then((result) => {
    const trusted = result === undefined ? undefined : trustedIn(result)
    known.set(key, {
      state,
      trusted,
      ...(result === undefined && { failedAt: Date.now() }),
    })
    return trusted
  })
  asking.set(key, ask)
  try {
    return await ask
  } finally {
    asking.delete(key)
  }
}

/** Forgets every answer, as a test starting afresh does. */
export const forgetTrust = (): void => {
  known.clear()
  asking.clear()
}
