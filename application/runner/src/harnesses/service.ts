import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

import type { AgentIntegration, AgentName } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { ShellPaths } from "../shell/scripts.js"
import type { Harness, Install } from "./harness.js"
import { agents, harnesses } from "./registry.js"

export type HarnessesOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  /**
   * Whether agents' commands get the login shell's PATH and homes over `env`, as the
   * person's terminal has them. Off, `env` is used as it is, as a test that sets the
   * exact PATH needs.
   */
  readonly login?: boolean
  readonly platform?: NodeJS.Platform
  /** How long one of an agent's plugin commands may take, in milliseconds. */
  readonly timeoutMs?: number
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

// Windows' cmd reads an argument in double quotes as it is; a path cannot hold one.
const cmdLine = (argv: readonly string[]): string =>
  argv.map((arg) => (/^[\w@.:\\/-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ")

// Variables the person's terminal has that decide where agents are and live.
const loginVariables = new Set(["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"])
const marker = "__NOVADECK_ENV__"

/**
 * The environment the person has in a terminal: their login shell's startup files put
 * agents on PATH, and may move their homes, even when the app was started from a
 * desktop menu. Only `echo` and `env` run in that shell, so any shell will do. Windows
 * programs get the person's environment already.
 */
const loginEnvironment = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  new Promise<NodeJS.ProcessEnv>((resolve) => {
    if (platform === "win32") return resolve(env)
    let output = ""
    let done = false
    // Startup files may print before the marker's own line; a shell may also echo it in
    // a variable of its own, such as `_`.
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdout.destroy()
      const lines = output.split("\n")
      const start = lines.indexOf(marker)
      if (start < 0) return resolve(env)
      const found: NodeJS.ProcessEnv = {}
      for (const line of lines.slice(start + 1)) {
        const split = line.indexOf("=")
        const name = line.slice(0, split)
        if (split > 0 && loginVariables.has(name)) found[name] = line.slice(split + 1)
      }
      resolve({ ...env, ...found })
    }
    const child = spawn(env.SHELL || "/bin/sh", ["-ilc", `echo ${marker}; env`], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    })
    // A background job the startup files leave behind may hold the output open: the
    // shell's own exit, or a time limit, ends the wait.
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, 10_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (output += chunk))
    child.on("error", finish)
    child.on("exit", () => setTimeout(finish, 100))
  })

// The program to run: the one on PATH, or where the harness's installer puts it otherwise.
const locate = async (program: string, harness: Harness, install: Install): Promise<string> => {
  for (const directory of (install.env.PATH ?? "").split(delimiter).filter(Boolean))
    // eslint-disable-next-line no-await-in-loop -- The first match wins.
    if (await exists(join(directory, program))) return program
  const fallback = program === harness.id ? harness.fallback?.(install.home) : undefined
  return fallback && (await exists(fallback)) ? fallback : program
}

/**
 * Runs one of an agent's commands the way the person would in a terminal: with their
 * login environment, and through cmd on Windows, where agents install as .cmd files.
 */
const run = (
  argv: readonly string[],
  {
    env,
    platform,
    timeoutMs,
  }: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; timeoutMs: number },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const [program = "", ...args] = argv
    const child =
      platform === "win32"
        ? spawn(env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine(argv)}"`], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(program, args, { env, stdio: ["ignore", "ignore", "pipe"] })
    let errors = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-2000)
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `${argv.slice(0, 3).join(" ")} failed: ${errors.trim().split("\n").at(-1) ?? code}`,
          ),
        )
    })
  })

/** The harnesses NovaDeck can connect, and connecting or disconnecting each one. */
export const createHarnesses = (
  paths: () => Promise<ShellPaths | undefined>,
  options: HarnessesOptions = {},
) => {
  const base = options.env ?? process.env
  const home = options.home ?? base.HOME ?? homedir()
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 60_000
  // Looked up in the background from the start, and again before each change. Listing
  // and spawning shells never wait for it: until it answers they use the app's own.
  let latest: NodeJS.ProcessEnv | undefined
  const lookUp = () =>
    (options.login === false ? Promise.resolve(base) : loginEnvironment(base, platform)).then(
      (found) => {
        latest = found
        return found
      },
    )
  void lookUp()
  const state = async (harness: Harness, install: Install): Promise<AgentIntegration> => ({
    agent: harness.id,
    available: await exists(harness.home(install)),
    connected: await harness.connected(install),
  })
  // Where each harness lives, once the shell files say where its plugin is.
  const installs = async (fresh = false) => {
    const shell = await paths()
    const env = fresh ? await lookUp() : (latest ?? base)
    return (
      shell &&
      ((agent: AgentName): Install => ({ env, home, platform, plugin: shell.plugins[agent] }))
    )
  }
  // One change at a time: an agent's plugin commands edit its configuration.
  let queue = Promise.resolve()
  return {
    /** Where the agent lives on this machine, once the shell files say where its plugin is. */
    install: async (agent: AgentName): Promise<Install | undefined> => (await installs())?.(agent),
    /** Whether NovaDeck's plugin is installed into the agent. */
    connected: async (agent: AgentName): Promise<boolean> => {
      const install = await installs()
      return install ? harnesses[agent].connected(install(agent)) : false
    },
    /** The connected harnesses whose shims NovaDeck's shells put first on PATH. */
    shims: async (): Promise<AgentName[]> => {
      const install = await installs()
      if (!install) return []
      const shimmed = agents.filter(
        (agent) => (harnesses[agent].shims?.(platform) ?? []).length > 0,
      )
      const connected = await Promise.all(
        shimmed.map((agent) => harnesses[agent].connected(install(agent))),
      )
      return shimmed.filter((_, index) => connected[index])
    },
    list: async (): Promise<AgentIntegration[]> => {
      const install = await installs()
      if (!install) return agents.map((agent) => ({ agent, available: false, connected: false }))
      return Promise.all(agents.map((agent) => state(harnesses[agent], install(agent))))
    },
    /** Installs or removes NovaDeck's plugin in the agent; resolves to where it stands after. */
    set: (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
      const change = queue.then(async () => {
        const install = await installs(true)
        const env = latest ?? base
        const settings = { env, platform, timeoutMs }
        if (!install)
          throw new DomainError("AGENT_SETUP_FAILED", "Shell integration is unavailable.")
        const harness = harnesses[agent]
        const where = install(agent)
        if (!(await exists(harness.home(where))))
          throw new DomainError("AGENT_SETUP_FAILED", `${agent} is not installed here.`)
        const settle = async (step: "apply" | "revert") => {
          try {
            await harness.settings?.[step](where)
          } catch (error) {
            throw new DomainError(
              "AGENT_SETUP_FAILED",
              error instanceof Error ? error.message : String(error),
            )
          }
        }
        // Its own settings go back before its plugin does, so nothing names a missing hook.
        if (!connected) await settle("revert")
        for (const command of connected ? harness.connect(where) : harness.disconnect) {
          try {
            const [program = "", ...args] = command.argv
            // eslint-disable-next-line no-await-in-loop -- Each step needs the one before.
            const located = platform === "win32" ? program : await locate(program, harness, where)
            // eslint-disable-next-line no-await-in-loop -- As above.
            await run([located, ...args], settings)
          } catch (error) {
            if (command.optional) continue
            throw new DomainError(
              "AGENT_SETUP_FAILED",
              error instanceof Error ? error.message : String(error),
            )
          }
        }
        const after = await state(harness, where)
        if (after.connected !== connected)
          throw new DomainError(
            "AGENT_SETUP_FAILED",
            `${agent} did not ${connected ? "install" : "remove"} NovaDeck's plugin.`,
          )
        if (connected) await settle("apply")
        return after
      })
      queue = change.then(
        () => {},
        () => {},
      )
      return change
    },
  }
}

export type Harnesses = ReturnType<typeof createHarnesses>
