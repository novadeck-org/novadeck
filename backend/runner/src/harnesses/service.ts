import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

import type { Harness, Install, Model } from "@novadeck/harness-core/harness"
import type { AgentIntegration, AgentName } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import { refreshPath } from "@novadeck/terminal/shell"

import { DomainError } from "../errors.js"
import { exists } from "../files.js"
import { logs } from "../log.js"
import type { ShellPaths } from "../shell/scripts.js"
import { list } from "../text.js"
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
  /**
   * The runner's own relay, which reads Windows' registry for PATH; the one
   * `@novadeck/relay` built when omitted. Never the copy installed for agents, which may
   * be another build's.
   */
  readonly relay?: string
  /**
   * Whether cmd prints before every command (Windows), as the runner knows now: no launch
   * grant is given while it does (`relayVerified`). No, when omitted.
   */
  readonly cmdPrints?: () => boolean
}

/**
 * The Novadeck terminals running an agent, which the service asks before it changes a plugin
 * under them (see `holdsPlugin`): by handle, those whose agent runs, and those of them
 * started narrowed.
 */
export type RunningAgents = {
  readonly running: (agent: AgentName) => readonly string[]
  readonly narrowed: (agent: AgentName) => readonly string[]
}

/**
 * Whether the harness's plugin must not change while a Novadeck terminal runs it: one whose
 * launch grants (Antigravity's) leave only its hook between a granted program and the person.
 * Its plugin is global, so a reinstall (which uninstalls first) would leave a running
 * terminal with no hook, and a granted program would run unasked.
 */
const holdsPlugin = (harness: Harness): boolean =>
  harness.messaging.permission.narrowed !== undefined

// Windows' cmd reads an argument in double quotes as it is; a path cannot hold one.
const cmdLine = (argv: readonly string[]): string =>
  argv.map((arg) => (/^[\w@.:\\/-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ")

// Variables the person's terminal has that decide where agents are and live.
const loginVariables = new Set(["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"])
const marker = "__NOVADECK_ENV__"

// What the login shell's startup files set; see `loginEnvironment`.
const loginShellEnvironment = (env: NodeJS.ProcessEnv) =>
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

/**
 * The environment the person has in a terminal: their login shell's startup files put
 * agents on PATH, and may move their homes, even when the app was started from a
 * desktop menu. Only `echo` and `env` run in that shell, so any shell will do. Windows
 * keeps PATH in the registry instead, read anew there; see `refreshPath`.
 */
const loginEnvironment = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, relay: string) =>
  platform === "win32" ? refreshPath(env, { platform, relay }) : loginShellEnvironment(env)

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
  paths: () => Promise<(ShellPaths & { readonly narrowedBefore?: boolean }) | undefined>,
  options: HarnessesOptions = {},
) => {
  const base = options.env ?? process.env
  const home = options.home ?? base.HOME ?? homedir()
  const platform = options.platform ?? process.platform
  const relay = options.relay ?? relayPath
  const timeoutMs = options.timeoutMs ?? 60_000
  // Whether cmd prints before every command, as the runner knows now (`AutoRun.printing`).
  const cmdPrints = options.cmdPrints ?? (() => false)
  // Looked up in the background from the start, and again before each change. Listing
  // and spawning shells never wait for it: until it answers they use the app's own.
  let latest: NodeJS.ProcessEnv | undefined
  const lookUp = () =>
    (options.login === false
      ? Promise.resolve(base)
      : loginEnvironment(base, platform, relay)
    ).then((found) => {
      latest = found
      return found
    })
  void lookUp()
  // Where each harness lives, once the shell files say where its plugin is.
  // Set when a previous runner left a narrowed terminal: its agent may still run, unseen.
  let narrowedBefore = false
  const installs = async (fresh = false) => {
    const shell = await paths()
    if (shell?.narrowedBefore === true) narrowedBefore = true
    const env = fresh ? await lookUp() : (latest ?? base)
    return (
      shell &&
      ((agent: AgentName): Install => ({ env, home, platform, plugin: shell.plugins[agent] }))
    )
  }
  // The agents whose installed version takes launch grants; an unknown version is retried.
  const grantable = new Set<AgentName>()
  const takesGrants = async (
    agent: AgentName,
    takes: (output: string) => boolean,
    where: Install,
  ): Promise<boolean> => {
    if (grantable.has(agent)) return true
    // On Windows through cmd, as the agent installs as a .cmd file there (see `run`).
    const program = platform === "win32" ? agent : await locate(agent, harnesses[agent], where)
    const output = await new Promise<string>((resolve) => {
      let text = ""
      const [file, args, extra] =
        platform === "win32"
          ? ([
              where.env.COMSPEC || "cmd.exe",
              ["/d", "/s", "/c", `"${cmdLine([program, "--version"])}"`],
              { windowsVerbatimArguments: true, windowsHide: true },
            ] as const)
          : ([program, ["--version"], {}] as const)
      const child = spawn(file, args, {
        env: where.env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        ...extra,
      })
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => (text += chunk))
      child.on("error", () => resolve(""))
      child.on("close", () => resolve(text))
    })
    if (takes(output)) grantable.add(agent)
    return grantable.has(agent)
  }
  // One change at a time: an agent's plugin commands edit its configuration.
  let queue = Promise.resolve()
  // The agents the person asked to disconnect, until that is done.
  const disconnecting = new Set<AgentName>()
  // Which Novadeck terminals run which agent, once the terminals exist.
  let terminals: RunningAgents | undefined
  const running = (agent: AgentName): readonly string[] =>
    holdsPlugin(harnesses[agent]) ? (terminals?.running(agent) ?? []) : []
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
    const settings = { env, platform, timeoutMs }
    if (!install) throw new DomainError("AGENT_SETUP_FAILED", "Shell integration is unavailable.")
    const harness = harnesses[agent]
    const where = install(agent)
    if (!(await exists(harness.home(where))))
      throw new DomainError("AGENT_SETUP_FAILED", `${agent} is not installed here.`)
    // Connecting an installed plugin uninstalls it first, which a running terminal of the
    // agent must not see: its launch grants would then run unasked.
    const held = running(agent)
    if (connected && held.length > 0 && (await harness.connected(where)))
      throw new DomainError(
        "AGENT_SETUP_FAILED",
        `Novadeck won't install its plugin into ${agent} again while ${list(held)} run${
          held.length === 1 ? "s" : ""
        } it: close ${held.length === 1 ? "it" : "them"} first.`,
      )
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
        `${agent} did not ${connected ? "install" : "remove"} Novadeck's plugin.`,
      )
    if (connected) await settle("apply")
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
    /** Where the agent lives on this machine, once the shell files say where its plugin is. */
    install: async (agent: AgentName): Promise<Install | undefined> => (await installs())?.(agent),
    /** Whether Novadeck's plugin is installed into the agent. */
    connected: async (agent: AgentName): Promise<boolean> => {
      const install = await installs()
      return install ? harnesses[agent].connected(install(agent)) : false
    },
    /** The connected harnesses whose shims Novadeck's shells put first on PATH. */
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
    /** Tells the service which Novadeck terminals run which agent, once they exist. */
    track: (source: RunningAgents): void => {
      terminals = source
    },
    /**
     * Whether the agent's installed plugin is verified, in its turn among the changes to it:
     * connected, byte for byte what this Novadeck renders, with no reinstall pending and no
     * disconnect asked; on Windows also with the relay its hook runs alone byte for byte what
     * this Novadeck ships, and cmd printing nothing. A terminal gets launch grants only then.
     */
    verified: (agent: AgentName): Promise<boolean> =>
      queued(async () => {
        const install = await installs()
        const { installed, takesLaunchGrants } = harnesses[agent]
        if (!install || !installed || disconnecting.has(agent)) return false
        const where = install(agent)
        if (platform === "win32" && takesLaunchGrants !== undefined) {
          const shell = await paths()
          if (!shell || !(await relayVerified(shell, relay, where, cmdPrints()))) return false
        }
        return (
          (await harnesses[agent].connected(where)) &&
          !(await exists(reinstalling(where))) &&
          !(await differing(installed, where)) &&
          (takesLaunchGrants === undefined || (await takesGrants(agent, takesLaunchGrants, where)))
        )
      }),
    list: async (): Promise<AgentIntegration[]> => {
      const install = await installs()
      if (!install) return agents.map((agent) => ({ agent, available: false, connected: false }))
      return Promise.all(agents.map((agent) => state(harnesses[agent], install(agent))))
    },
    /** Installs or removes Novadeck's plugin in the agent; resolves to where it stands after. */
    set: (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
      if (connected) return queued(() => apply(agent, true))
      // A terminal started under a grant keeps it only while Novadeck's hook is there.
      const narrowed = holdsPlugin(harnesses[agent]) ? (terminals?.narrowed(agent) ?? []) : []
      if (narrowed.length > 0)
        return Promise.reject(
          new DomainError(
            "AGENT_SETUP_FAILED",
            `Novadeck can't disconnect ${agent} while ${list(narrowed)} run${
              narrowed.length === 1 ? "s" : ""
            } it under your grant: close ${narrowed.length === 1 ? "it" : "them"} first.`,
          ),
        )
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
            if (disconnecting.has(agent)) return false
            // Not under a running terminal: its launch grants rest on the hook it has.
            if (running(agent).length > 0 || (narrowedBefore && holdsPlugin(harnesses[agent]))) {
              log.info(
                "harnesses.refresh-held",
                `Novadeck left ${agent}'s plugin as it is while a terminal runs it`,
                { data: { agent } },
              )
              return false
            }
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
            await apply(agent, true)
            await rm(reinstalling(where), { force: true })
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
  }
  return api
}

/**
 * Whether Windows' hook of a narrowed Antigravity is what this Novadeck ships: the relay
 * installed for agents is the `shipped` one byte for byte, as that one prints `force_ask` on
 * every path of a narrowed terminal; the plugin registers PreToolUse, which it does not
 * where cmd prints (`cmdPrints`: Antigravity may wrap the hook in cmd, then no answer reads
 * as JSON) or the relay has no path cmd reads as it is; and cmd printing (`cmdPrints`, the runner's live answer) is not set.
 */
export const relayVerified = async (
  shell: ShellPaths,
  shipped: string,
  where: Install,
  cmdPrints: boolean,
): Promise<boolean> => {
  if (cmdPrints) return false
  try {
    const [ours, installed, hooks] = await Promise.all([
      readFile(shipped),
      readFile(shell.relay),
      readFile(join(where.plugin, "hooks.json"), "utf8"),
    ])
    return hooks.includes('"PreToolUse"') && ours.equals(installed)
  } catch {
    return false
  }
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
