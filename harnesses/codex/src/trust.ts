import { execFile, spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

import { codexHome } from "./home.js"
import { pluginId } from "./plugin.js"

/**
 * The hooks without which nothing reaches a Codex session: SessionStart binds it, the
 * prompt's and Stop's hooks deliver and confirm a ring, and PreToolUse tells the questions
 * and permissions that ask with no PermissionRequest. Codex 0.163 and older keep trust per
 * hook, so a change to one hook's matcher leaves only that one `modified`.
 */
const needed = ["sessionStart", "userPromptSubmit", "stop", "preToolUse"] as const

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
    let finished = false
    const done = (value: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const close = () => {
        child.stdin.destroy()
        child.stdout.destroy()
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
          child.kill()
        resolve(value)
      }
      // Killing cmd alone leaves the npm launcher and app-server behind. Finish ending
      // their tree before another check can start; a hung cleanup is bounded too.
      if (
        where.platform === "win32" &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      )
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 3_000 },
          close,
        )
      else close()
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

// When a file last changed and its size, as a timestamp alone may stay put on a coarse
// clock; 0 when it isn't there.
const changed = (path: string): Promise<string> =>
  stat(path).then(
    (file) => `${file.mtimeMs}/${file.size}`,
    () => "0",
  )

/**
 * What trust depends on, as it changes: Codex's `config.toml`, which records it, and every
 * file of Novadeck's plugin, as Codex keeps it in its plugin cache, which a plugin's
 * reinstall rewrites (and which then reads "modified"). From 0.164.0 Codex hashes the
 * plugin's whole folder into each hook's hash, so another build's launcher in `.mcp.json`
 * alone changes it (probed 2026-10-27; 0.163.0 hashed the hook definitions alone).
 */
const stateOf = async (home: string): Promise<string> => {
  const cache = join(home, "plugins", "cache", "novadeck", "novadeck")
  const files = await readdir(cache, { recursive: true, withFileTypes: true }).catch(() => [])
  const plugin = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted()
      .map(async (path) => `${relative(cache, path)}:${await changed(path)}`),
  )
  return [await changed(join(home, "config.toml")), ...plugin].join("|")
}

type Known = {
  readonly state: string
  readonly trusted: boolean
}
const known = new Map<string, Known>()
const asking = new Map<string, Promise<boolean | undefined>>()

/**
 * Whether Novadeck's Codex hooks run in `cwd`: Codex runs a plugin's hooks only once the
 * person trusts them, and no hook says when it doesn't, so its app-server is asked. The
 * answer is kept until Codex's configuration or Novadeck's plugin changes.
 * Undefined when Codex couldn't answer (it couldn't start, or didn't answer within 10 s):
 * unknown, never taken for untrusted or cached, so a later check can recover. Asks under
 * way are shared.
 */
export const hooksTrusted = async (where: Asking, cwd: string): Promise<boolean | undefined> => {
  const home = codexHome(where)
  const key = `${where.program ?? "codex"}\0${home}\0${cwd}`
  const state = await stateOf(home)
  const kept = known.get(key)
  if (kept?.state === state) return kept.trusted
  const pending = asking.get(key)
  if (pending) return pending
  const ask = listHooks(where, cwd, 10_000).then((result) => {
    const trusted = result === undefined ? undefined : trustedIn(result)
    if (trusted !== undefined) known.set(key, { state, trusted })
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
