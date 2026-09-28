import { spawn } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

import type { AgentIntegration, AgentName } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { ShellPaths } from "./scripts.js"

export type AgentsOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** How long one of an agent's plugin commands may take, in milliseconds. */
  readonly timeoutMs?: number
}

const agents = ["claude", "codex", "agy"] as const satisfies readonly AgentName[]

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const text = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "")

type Agent = {
  /** The agent's own home, whose presence says it is installed. */
  readonly home: string
  /** Whether the agent's own configuration lists NovaDeck's plugin as installed. */
  readonly connected: () => Promise<boolean>
  /** Its plugin commands, run in order; a failing one marked `optional` is skipped. */
  readonly connect: readonly Command[]
  readonly disconnect: readonly Command[]
}
type Command = { readonly argv: readonly string[]; readonly optional?: boolean }

const plugin = "novadeck@novadeck"

/**
 * Each agent, as its own files and commands describe it. NovaDeck only reads the
 * agent's configuration; installing and removing its plugin goes through the agent's
 * own `plugin` commands, which own that configuration.
 */
const describe = (paths: ShellPaths, env: NodeJS.ProcessEnv, home: string) => {
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  const codex = env.CODEX_HOME || join(home, ".codex")
  const gemini = join(home, ".gemini")
  return {
    claude: {
      home: claude,
      connected: async () => {
        try {
          const settings = JSON.parse(await text(join(claude, "settings.json"))) as {
            enabledPlugins?: Record<string, unknown>
          }
          return settings.enabledPlugins?.[plugin] === true
        } catch {
          return false
        }
      },
      connect: [
        // A marketplace left from an earlier connection is replaced, not added twice.
        { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
        { argv: ["claude", "plugin", "marketplace", "add", paths.plugins.claude] },
        { argv: ["claude", "plugin", "install", plugin] },
      ],
      disconnect: [
        { argv: ["claude", "plugin", "uninstall", plugin], optional: true },
        { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
      ],
    },
    codex: {
      home: codex,
      connected: async () =>
        /\[plugins\."novadeck@novadeck"\][^[]*?\benabled\s*=\s*true/.test(
          await text(join(codex, "config.toml")),
        ),
      connect: [
        { argv: ["codex", "plugin", "marketplace", "remove", "novadeck"], optional: true },
        { argv: ["codex", "plugin", "marketplace", "add", paths.plugins.codex] },
        { argv: ["codex", "plugin", "add", plugin] },
      ],
      disconnect: [
        { argv: ["codex", "plugin", "remove", plugin], optional: true },
        { argv: ["codex", "plugin", "marketplace", "remove", "novadeck"], optional: true },
      ],
    },
    // Antigravity keeps its own state beside other Google tools in ~/.gemini.
    agy: {
      home: join(gemini, "antigravity-cli"),
      connected: () => exists(join(gemini, "config", "plugins", "novadeck", "plugin.json")),
      connect: [
        { argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true },
        { argv: ["agy", "plugin", "install", paths.plugins.agy] },
      ],
      disconnect: [{ argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true }],
    },
  } satisfies Record<AgentName, Agent>
}

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

// Claude Code's local install is an alias in the user's rc file, not on PATH.
const fallbacks: Partial<Record<string, (home: string) => string>> = {
  claude: (home) => join(home, ".claude", "local", "claude"),
}

// The program to run: the one on PATH, or where its installer puts it otherwise.
const locate = async (program: string, env: NodeJS.ProcessEnv, home: string): Promise<string> => {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean))
    // eslint-disable-next-line no-await-in-loop -- The first match wins.
    if (await exists(join(directory, program))) return program
  const fallback = fallbacks[program]?.(home)
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

/** The agents NovaDeck can connect, and connecting or disconnecting each one. */
export const createAgents = (
  paths: () => Promise<ShellPaths | undefined>,
  options: AgentsOptions = {},
) => {
  const base = options.env ?? process.env
  const home = options.home ?? base.HOME ?? homedir()
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 60_000
  // Looked up in the background from the start, and again before each change. Listing
  // and spawning shells never wait for it: until it answers they use the app's own.
  let latest: NodeJS.ProcessEnv | undefined
  const lookUp = () =>
    loginEnvironment(base, platform).then((found) => {
      latest = found
      return found
    })
  void lookUp()
  const state = async (agent: AgentName, found: Agent): Promise<AgentIntegration> => ({
    agent,
    available: await exists(found.home),
    connected: await found.connected(),
  })
  const known = async (fresh = false) => {
    const shell = await paths()
    const env = fresh ? await lookUp() : (latest ?? base)
    return shell && describe(shell, env, home)
  }
  // One change at a time: an agent's plugin commands edit its configuration.
  let queue = Promise.resolve()
  return {
    /** Whether NovaDeck's plugin is installed into the agent. */
    connected: async (agent: AgentName): Promise<boolean> => {
      const described = await known()
      return described ? described[agent].connected() : false
    },
    list: async (): Promise<AgentIntegration[]> => {
      const described = await known()
      if (!described) return agents.map((agent) => ({ agent, available: false, connected: false }))
      return Promise.all(agents.map((agent) => state(agent, described[agent])))
    },
    /** Installs or removes NovaDeck's plugin in the agent; resolves to where it stands after. */
    set: (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
      const change = queue.then(async () => {
        const described = await known(true)
        const env = latest ?? base
        const settings = { env, platform, timeoutMs }
        if (!described)
          throw new DomainError("AGENT_SETUP_FAILED", "Shell integration is unavailable.")
        const found = described[agent]
        if (!(await exists(found.home)))
          throw new DomainError("AGENT_SETUP_FAILED", `${agent} is not installed here.`)
        for (const command of connected ? found.connect : found.disconnect) {
          try {
            const [program = "", ...args] = command.argv
            // eslint-disable-next-line no-await-in-loop -- Each step needs the one before.
            const located = platform === "win32" ? program : await locate(program, env, home)
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
        const after = await state(agent, found)
        if (after.connected !== connected)
          throw new DomainError(
            "AGENT_SETUP_FAILED",
            `${agent} did not ${connected ? "install" : "remove"} NovaDeck's plugin.`,
          )
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

export type Agents = ReturnType<typeof createAgents>
