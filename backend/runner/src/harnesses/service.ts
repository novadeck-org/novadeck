import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Command, Harness, Install, Model } from "@novadeck/harness-core/harness"
import type { AgentIntegration, AgentName } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import { refreshPath } from "@novadeck/terminal/shell"

import { secretVariables } from "../companions/secrets.js"
import { DomainError } from "../errors.js"
import { exists } from "../files.js"
import { logs } from "../log.js"
import { cmdPath, findProgram, killTree } from "../programs.js"
import { withoutInherited } from "../shell/inherited.js"
import type { ShellPaths } from "../shell/scripts.js"
import { worktreesRoot } from "../worktrees/root.js"
import { agents, harnesses } from "./registry.js"

const log = logs.for("harnesses")

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
  /** How long the login shell's lookup may take, in milliseconds. */
  readonly loginTimeoutMs?: number
  /**
   * The runner's own relay, which reads Windows' registry for PATH; the one
   * `@novadeck/relay` built when omitted. Never the copy installed for agents, which may
   * be another build's.
   */
  readonly relay?: string
}

// Windows' cmd reads an argument in double quotes as it is; a path cannot hold one.
const cmdLine = (argv: readonly string[]): string =>
  argv.map((arg) => (/^[\w@.:\\/-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ")

// Variables the person's terminal has that decide where agents are and live.
const loginVariables = new Set(["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"])
// Those that say where their tools keep their logins, in any case, as npm writes its own.
const toolVariables = new Set(secretVariables)
const kept = (name: string) => loginVariables.has(name) || toolVariables.has(name.toUpperCase())
// The login shell's environment as agents' own commands get it: only what decides where
// agents are and live comes from the shell, and the tools' variables stay the app's own.
const forAgents = (found: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(found).flatMap(([name, value]) => {
      if (loginVariables.has(name) || !toolVariables.has(name.toUpperCase())) return [[name, value]]
      return name in base ? [[name, base[name]]] : []
    }),
  )
const marker = "__NOVADECK_ENV__"

// What the login shell's startup files set; see `loginEnvironment`. `signal` or `timeoutMs`
// ends the shell, by SIGKILL, as an interactive one ignores SIGTERM.
const loginShellEnvironment = (env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number) =>
  new Promise<NodeJS.ProcessEnv>((resolve) => {
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
        if (split > 0 && kept(name)) found[name] = line.slice(split + 1)
      }
      resolve({ ...env, ...found })
    }
    const child = spawn(env.SHELL || "/bin/sh", ["-ilc", `echo ${marker}; env`], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      signal,
      killSignal: "SIGKILL",
    })
    // A background job the startup files leave behind may hold the output open: the
    // shell's own exit, or a time limit, ends the wait.
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish()
    }, timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (output += chunk))
    child.on("error", finish)
    child.on("exit", () => setTimeout(finish, 100))
  })

/**
 * The environment the person has in a terminal: their login shell's startup files put
 * agents on PATH, and may move their homes, even when the app was started from a
 * desktop menu. Only `echo` and `env` run in that shell, so any shell will do. Windows
 * keeps PATH in the registry instead, read anew there; see `refreshPath`.
 */
const loginEnvironment = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  relay: string,
  signal: AbortSignal,
  timeoutMs: number,
) =>
  platform === "win32"
    ? refreshPath(env, { platform, relay })
    : loginShellEnvironment(env, signal, timeoutMs)

/**
 * The program to run, by its absolute path: the one on PATH, or where the harness's installer
 * puts it otherwise. Never one in the runner's working folder, which Windows would search
 * first (see `findProgram`); undefined where there is none.
 */
const locate = async (
  program: string,
  harness: Harness,
  install: Install,
): Promise<string | undefined> => {
  const found = findProgram(program, { env: install.env, platform: install.platform })
  if (found) return found
  const fallback = program === harness.id ? harness.fallback?.(install.home) : undefined
  return fallback && (await exists(fallback)) ? fallback : undefined
}

/** How an agent's commands run: in `cwd`, the person's home, with `env`, for `timeoutMs` at most. */
type Settings = {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly timeoutMs: number
}

/**
 * Runs one of an agent's commands the way the person would in a terminal: with their
 * login environment, and through cmd on Windows, where agents install as .cmd files.
 * `argv` starts with the program's absolute path (see `locate`); `name` is what the
 * command calls it, for its failure. It runs in the person's home, as their terminal
 * starts, so no project's own configuration applies. Past `timeoutMs` it fails, and the program ends with
 * all it started: ending cmd.exe alone leaves the agent running, and a child that holds the
 * error output open would keep the command from ever settling.
 */
const run = (
  name: string,
  argv: readonly string[],
  { cwd, env, platform, timeoutMs }: Settings,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const [program = "", ...args] = argv
    const what = [name, ...args].slice(0, 3).join(" ")
    const child =
      platform === "win32"
        ? spawn(cmdPath(env), ["/d", "/s", "/c", `"${cmdLine(argv)}"`], {
            cwd,
            env,
            stdio: ["ignore", "ignore", "pipe"],
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(program, args, {
            cwd,
            env,
            // Its own group, so the time limit ends what it started too.
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          })
    let errors = ""
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-2000)
    })
    const timer = setTimeout(() => {
      killTree(child.pid, platform)
      settle(new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
    child.on("error", settle)
    child.on("close", (code) => {
      if (code === 0) return settle()
      settle(new Error(`${what} failed: ${errors.trim().split("\n").at(-1) ?? code}`))
    })
  })

// Runs an agent's plugin commands in order; a failing one that isn't optional fails them all.
const steps = async (
  harness: Harness,
  where: Install,
  commands: readonly Command[],
  settings: Settings,
): Promise<void> => {
  for (const command of commands) {
    try {
      const [program = "", ...args] = command.argv
      // eslint-disable-next-line no-await-in-loop -- Each step needs the one before.
      const located = await locate(program, harness, where)
      if (!located) throw new Error(`${program} is not on PATH.`)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await run(program, [located, ...args], settings)
    } catch (error) {
      if (command.optional) continue
      throw new DomainError(
        "AGENT_SETUP_FAILED",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

const state = async (harness: Harness, install: Install): Promise<AgentIntegration> => {
  const connected = await harness.connected(install)
  const limited = connected ? await harness.limited?.(install).catch(() => undefined) : undefined
  return {
    agent: harness.id,
    available: await exists(harness.home(install)),
    connected,
    ...(limited !== undefined && { limited }),
  }
}

/** The harnesses Novadeck can connect, and connecting or disconnecting each one. */
export const createHarnesses = (
  paths: () => Promise<(ShellPaths & { readonly cmdShimDir?: string | undefined }) | undefined>,
  options: HarnessesOptions = {},
) => {
  const platform = options.platform ?? process.platform
  // The runner's own token, and an agent session's markers, never reach the login shell's
  // startup files or an agent's commands, as they never reach a terminal (see `inherited`).
  const base = withoutInherited(options.env ?? process.env, platform)
  const home = options.home ?? base.HOME ?? homedir()
  const relay = options.relay ?? relayPath
  const timeoutMs = options.timeoutMs ?? 60_000
  // Ends the login shell's lookup and any refresh still to run; see `close`.
  const closing = new AbortController()
  // Looked up in the background from the start, and again before each change. Listing
  // and spawning shells never wait for it: until it answers they use the app's own.
  let latest: NodeJS.ProcessEnv | undefined
  // The same with the tools' variables as the shell has them, for `environment` alone.
  let person: NodeJS.ProcessEnv | undefined
  const lookUp = () =>
    (options.login === false
      ? Promise.resolve(base)
      : loginEnvironment(base, platform, relay, closing.signal, options.loginTimeoutMs ?? 10_000)
    ).then((found) => {
      person = found
      latest = forAgents(found, base)
      return latest
    })
  void lookUp()
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
  // The agents the person asked to disconnect, until that is done.
  const disconnecting = new Set<AgentName>()
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const change = queue.then(work)
    queue = change.then(
      () => {},
      () => {},
    )
    return change
  }
  // Installs or removes the plugin in the agent, as `set` does, in its turn.
  const apply = async (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
    const install = await installs(true)
    const env = latest ?? base
    const settings = { cwd: home, env, platform, timeoutMs }
    if (!install) throw new DomainError("AGENT_SETUP_FAILED", "Shell integration is unavailable.")
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
    // A reinstall left unfinished is the person's to undo: disconnected, it stays so.
    if (!connected) await rm(reinstalling(where), { force: true })
    // Its own settings go back before its plugin does, so nothing names a missing hook.
    if (!connected) await settle("revert")
    const before = connected && (await harness.connected(where))
    await steps(harness, where, connected ? harness.connect(where) : harness.disconnect, settings)
    const after = await state(harness, where)
    if (after.connected !== connected)
      throw new DomainError(
        "AGENT_SETUP_FAILED",
        `${agent} did not ${connected ? "install" : "remove"} Novadeck's plugin.`,
      )
    if (!connected) return after
    try {
      await settle("apply")
    } catch (error) {
      // Settings it can't change, such as a file that doesn't parse, leave an agent the
      // person was connecting disconnected, not connected without them; one connected
      // before, as a refresh finds it, stays so.
      if (!before) await steps(harness, where, harness.disconnect, settings).catch(() => {})
      throw error
    }
    return after
  }
  const api = {
    /**
     * The models the agent can start with on this machine, each with its efforts, as the
     * harness tells them; none where it isn't installed or can't tell.
     */
    models: async (agent: AgentName): Promise<readonly Model[]> => {
      try {
        const where = (await installs())?.(agent)
        const harness = harnesses[agent]
        if (!where || !(await exists(harness.home(where)))) return []
        return await harness.launch.models(where)
      } catch (error) {
        log.warn("harnesses.models-failed", `Novadeck could not list ${agent}'s models`, {
          data: { agent },
          err: error,
        })
        return []
      }
    },
    /**
     * The person's environment as their terminal has it, as far as it is known: their
     * login shell's once it answered, the app's own until then.
     */
    environment: (): NodeJS.ProcessEnv => person ?? base,
    /** Where the agent lives on this machine, once the shell files say where its plugin is. */
    install: async (agent: AgentName): Promise<Install | undefined> => (await installs())?.(agent),
    /** The folders the agent keeps the plans it writes as files in (see `Harness.planFolders`). */
    planFolders: async (agent: AgentName): Promise<readonly string[]> => {
      // Before the shell files say where the plugin is, the agent's default home stands.
      const where = (await installs())?.(agent) ?? {
        env: latest ?? base,
        home,
        platform,
        plugin: "",
      }
      return harnesses[agent].planFolders?.(where) ?? []
    },
    /** Whether Novadeck's plugin is installed into the agent. */
    connected: async (agent: AgentName): Promise<boolean> => {
      const install = await installs()
      return install ? harnesses[agent].connected(install(agent)) : false
    },
    /** The connected harnesses whose shims Novadeck's shells put first on PATH. */
    shims: async (): Promise<AgentName[]> => {
      const install = await installs()
      if (!install) return []
      // Antigravity's Windows shim exists only where Novadeck's cmd.exe pass-through is
      // installed, or the worktrees folder is.
      const cmdShimDir = (await paths())?.cmdShimDir
      const machine = {
        worktreesPresent: existsSync(worktreesRoot(home)),
        ...(cmdShimDir !== undefined && { cmdShimDir }),
      }
      const shimmed = agents.filter(
        (agent) => (harnesses[agent].shims?.(platform, machine) ?? []).length > 0,
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
    /** Installs or removes Novadeck's plugin in the agent; resolves to where it stands after. */
    set: (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
      if (connected) return queued(() => apply(agent, true))
      // The person's disconnect stands from when it is asked for: a refresh queued ahead of
      // it leaves the agent alone, and a quit before it runs leaves no reinstall to finish.
      disconnecting.add(agent)
      void installs().then((install) =>
        install ? rm(reinstalling(install(agent)), { force: true }) : undefined,
      )
      return queued(() => apply(agent, false)).finally(() => disconnecting.delete(agent))
    },
    /**
     * Installs the plugin again into each connected agent that keeps a copy of it whose
     * files differ from Novadeck's (`Harness.installed`), as a connect would: a hook that
     * renders otherwise now, as where cmd prints first, reaches it no other way. Each looks
     * and installs in its turn among `set`'s changes, so a disconnect asked for first
     * stands. A reinstall is marked until it is done, so one a quit cut short between its
     * uninstall and its install, which leaves the agent looking disconnected, is finished
     * at the next start. Resolves to the agents it installed into; one that fails is
     * logged, and the rest go on.
     */
    refresh: async (): Promise<AgentName[]> => {
      const install = await installs()
      if (!install) return []
      const refreshed: AgentName[] = []
      for (const agent of agents) {
        const { installed } = harnesses[agent]
        if (!installed) continue
        const where = install(agent)
        try {
          // eslint-disable-next-line no-await-in-loop -- One agent at a time, as `set` runs them.
          const done = await queued(async () => {
            if (closing.signal.aborted || disconnecting.has(agent)) return false
            // An agent uninstalled since keeps no unfinished reinstall, nor takes one later.
            if (!(await exists(harnesses[agent].home(where)))) {
              await rm(reinstalling(where), { force: true })
              return false
            }
            const unfinished = await exists(reinstalling(where))
            const connected = await harnesses[agent].connected(where)
            if (!connected && !unfinished) return false
            if (connected && !(await differing(installed, where))) {
              if (unfinished) await rm(reinstalling(where), { force: true })
              return false
            }
            await writeFile(reinstalling(where), "")
            // The mark is for a reinstall a quit cut short: one that fails, as over settings
            // that don't parse, is logged and done, not tried again at every start.
            try {
              await apply(agent, true)
            } finally {
              await rm(reinstalling(where), { force: true })
            }
            // An agent that rewrites what it copies would be installed again at every start.
            if (await differing(installed, where))
              log.error(
                "harnesses.plugin-differs",
                `Novadeck installed its plugin into ${agent} again, and its copy still differs from Novadeck's.`,
                { data: { agent, files: installed.files.length } },
              )
            return true
          })
          if (done) refreshed.push(agent)
        } catch (error) {
          log.error(
            "harnesses.plugin-install-failed",
            `Novadeck could not install its changed plugin into ${agent}`,
            { data: { agent }, err: error },
          )
        }
      }
      return refreshed
    },
    /**
     * Ends the login shell's lookup and skips the agents a refresh hasn't reached, for a
     * runner that couldn't be built. Windows' lookup only reads the registry, for ten
     * seconds at most, and other callers share it, so it finishes.
     */
    close: (): Promise<void> => {
      closing.abort()
      return Promise.resolve()
    },
  }
  return api
}

// Marks a reinstall `refresh` began, beside Novadeck's own copy of the plugin, until done.
const reinstalling = (where: Install): string => `${where.plugin}.reinstalling`

// A plugin file's text, or undefined where it isn't there.
const read = (folder: string, name: string) =>
  readFile(join(folder, name), "utf8").catch(() => undefined)

// Whether the agent's copy of the plugin differs from Novadeck's in any file that must match.
const differing = async (
  installed: NonNullable<Harness["installed"]>,
  where: Install,
): Promise<boolean> => {
  const differs = await Promise.all(
    installed.files.map(async (name) => {
      const [ours, theirs] = await Promise.all([
        read(where.plugin, name),
        read(installed.directory(where), name),
      ])
      return ours !== undefined && ours !== theirs
    }),
  )
  return differs.includes(true)
}

export type Harnesses = ReturnType<typeof createHarnesses>
