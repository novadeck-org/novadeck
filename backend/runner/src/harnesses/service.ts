import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { Command, Harness, Install, Model } from "@novadeck/harness-core/harness"
import type { AgentIntegration, AgentName } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import { refreshPath } from "@novadeck/terminal/shell"

import { secretVariables } from "../companions/secrets.js"
import { DomainError } from "../errors.js"
import { exists } from "../files.js"
import { logs } from "../log.js"
import { agentLabel } from "../messaging/messages.js"
import { cmdPath, findProgram, killTree } from "../programs.js"
import { withoutInherited } from "../shell/inherited.js"
import type { ShellPaths } from "../shell/scripts.js"
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
  /** How often each agent's connection is looked at for a change outside Novadeck, in milliseconds. */
  readonly connectionPollMs?: number
  /** How long after a read that finds a connected agent disconnected it is read again, to confirm it. */
  readonly connectionConfirmMs?: number
}

/**
 * How often each agent's connection is looked at (`Harnesses.follow`): its plugin can go from
 * it outside Novadeck, as another program's disconnect, and agents of it asleep then can't be
 * woken until it is back. Each look reads one small file of each agent's.
 */
export const connectionPollMs = 15_000

/**
 * How long after a read that finds a connected agent disconnected it is read again before that
 * counts: a settings file caught mid-write, or another Novadeck's reinstall, reads as no plugin
 * for a moment.
 */
export const connectionConfirmMs = 1_000

/** One agent's connection changed, as `Harnesses.follow` tells it. */
export type ConnectionChange = {
  readonly agent: AgentName
  readonly connected: boolean
  /** Lost outside Novadeck (`AgentIntegration.lost`). */
  readonly lost: boolean
}

// Windows' cmd reads an argument in double quotes as it is; a path cannot hold one.
export const cmdLine = (argv: readonly string[]): string =>
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
 * The program to run, by its absolute path: the one on PATH, or where the harness's installers
 * put it otherwise (see `Harness.fallbacks`), which a PATH read before the install lacks.
 * Never one in the runner's working folder, which Windows would search first (see
 * `findProgram`); undefined where there is none.
 */
export const locate = async (
  program: string,
  harness: Harness,
  install: Install,
): Promise<string | undefined> => {
  const found = findProgram(program, { env: install.env, platform: install.platform })
  if (found) return found
  if (program !== harness.id) return undefined
  for (const fallback of harness.fallbacks?.(install) ?? [])
    // eslint-disable-next-line no-await-in-loop -- The first that is there wins.
    if (await exists(fallback)) return fallback
  return undefined
}

/**
 * Whether the harness is installed here: its home is there, or its program can be found.
 * A program freshly installed and never run has no home yet.
 */
const installedIn = async (harness: Harness, install: Install): Promise<boolean> =>
  (await exists(harness.home(install))) ||
  (await locate(harness.id, harness, install)) !== undefined

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

const state = async (
  harness: Harness,
  install: Install,
  lost: (connected: boolean) => boolean = () => false,
): Promise<AgentIntegration> => {
  const connected = await harness.connected(install)
  const limited = connected ? await harness.limited?.(install).catch(() => undefined) : undefined
  const available = await installedIn(harness, install)
  return {
    agent: harness.id,
    available,
    connected,
    ...(limited !== undefined && { limited }),
    ...(lost(connected) && { lost: true as const }),
    // What the person can run to get it, while it is missing.
    ...(!available && { installer: harness.installer(install.platform) }),
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
  // The lookup under way, which callers that ask meanwhile share: one shell answers them all.
  let looking: Promise<NodeJS.ProcessEnv> | undefined
  const lookUp = (): Promise<NodeJS.ProcessEnv> =>
    (looking ??= (
      options.login === false
        ? Promise.resolve(base)
        : loginEnvironment(base, platform, relay, closing.signal, options.loginTimeoutMs ?? 10_000)
    )
      .then((found) => {
        person = found
        latest = forAgents(found, base)
        return latest
      })
      .finally(() => {
        looking = undefined
      }))
  void lookUp()
  // A lookup begun after it is asked for, as a look after an install needs: one under way
  // may have started before the install changed the startup files, so it waits that one
  // out and asks the shell again. Fresh looks asked for together share that one shell.
  let renewing: Promise<NodeJS.ProcessEnv> | undefined
  const lookAfresh = (): Promise<NodeJS.ProcessEnv> =>
    (renewing ??= (looking ?? Promise.resolve())
      .catch(() => {})
      .then(lookUp)
      .finally(() => {
        renewing = undefined
      }))
  // Where each harness lives, once the shell files say where its plugin is. `shared` waits
  // for the lookup under way, or starts one; `fresh` for one begun after it is asked for.
  const installs = async (look: "latest" | "shared" | "fresh" = "latest") => {
    const shell = await paths()
    const env =
      look === "fresh" ? await lookAfresh() : look === "shared" ? await lookUp() : (latest ?? base)
    return (
      shell &&
      ((agent: AgentName): Install => ({ env, home, platform, plugin: shell.plugins[agent] }))
    )
  }
  // One change at a time: an agent's plugin commands edit its configuration.
  let queue = Promise.resolve()
  // The agents the person asked to disconnect, until that is done.
  const disconnecting = new Set<AgentName>()
  // Each agent's connection as last read, the agents whose plugin went from them outside
  // Novadeck, and those Novadeck's own commands are changing, whose reads meanwhile say
  // nothing of the person's (`note`).
  const known = new Map<AgentName, boolean>()
  const lost = new Set<AgentName>()
  const changing = new Map<AgentName, number>()
  // Each agent's count of Novadeck's own changes begun or ended: a read that spans one says
  // nothing of where it stands now.
  const epochs = new Map<AgentName, number>()
  const epoch = (agent: AgentName): number => epochs.get(agent) ?? 0
  const bump = (agent: AgentName): void => void epochs.set(agent, epoch(agent) + 1)
  const followers = new Set<(change: ConnectionChange) => void>()
  const tell = (change: ConnectionChange) => {
    for (const follower of followers) follower(change)
  }
  /**
   * What a read of an agent's connection says: one Novadeck isn't changing that was connected
   * and isn't is lost outside Novadeck, and logged; one connected again is found. Each change
   * is told.
   */
  const note = (agent: AgentName, connected: boolean): void => {
    if (changing.has(agent)) return
    const before = known.get(agent)
    known.set(agent, connected)
    if (before === undefined || before === connected) return
    if (!connected) {
      lost.add(agent)
      log.warn(
        "harnesses.disconnected",
        `${agentLabel(agent)} is no longer connected: Novadeck's plugin was removed from it outside Novadeck.`,
        { data: { agent } },
      )
    } else if (lost.delete(agent))
      log.info("harnesses.reconnected", `${agentLabel(agent)} is connected again.`, {
        data: { agent },
      })
    tell({ agent, connected, lost: lost.has(agent) })
  }
  // Novadeck's own commands change the agent's connection meanwhile; once they end, where it
  // stands is the person's, never lost.
  const own = async <T>(agent: AgentName, work: () => Promise<T>): Promise<T> => {
    changing.set(agent, (changing.get(agent) ?? 0) + 1)
    bump(agent)
    try {
      return await work()
    } finally {
      bump(agent)
      const left = (changing.get(agent) ?? 1) - 1
      if (left > 0) changing.set(agent, left)
      else changing.delete(agent)
    }
  }
  // After Novadeck's own change: where the agent stands now, told if it moved.
  const settled = (agent: AgentName, connected: boolean): void => {
    const before = known.get(agent)
    const was = lost.delete(agent)
    known.set(agent, connected)
    if (before !== connected || was) tell({ agent, connected, lost: false })
  }
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
    const install = await installs("shared")
    const env = latest ?? base
    const settings = { cwd: home, env, platform, timeoutMs }
    if (!install) throw new DomainError("AGENT_SETUP_FAILED", "Shell integration is unavailable.")
    const harness = harnesses[agent]
    const where = install(agent)
    if (!(await installedIn(harness, where)))
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
    // A harness connected by a file of Novadeck's own (`Harness.marker`): written before its
    // commands, removed after them, so what reads it never names a plugin half set up.
    const connection = harness.marker?.(where)
    if (connection !== undefined && connected) {
      await mkdir(dirname(connection), { recursive: true })
      await writeFile(connection, "connected\n")
    }
    await steps(harness, where, connected ? harness.connect(where) : harness.disconnect, settings)
    if (connection !== undefined && !connected) await rm(connection, { force: true })
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
        if (!where || !(await installedIn(harness, where))) return []
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
    /**
     * The folders every harness keeps for itself under its own home (its plans, memory,
     * conversations, logs: see `Harness.bookkeeping`), as the runner's own environment moves
     * them. What an agent writes there is no work the person asked for; the rest of a home
     * (a skill, a settings file) is.
     */
    bookkeeping: async (): Promise<readonly string[]> => {
      const installed = (await installs()) ?? (() => undefined)
      const fallback: Install = { env: latest ?? base, home, platform, plugin: "" }
      return Object.values(harnesses).flatMap(
        (each) => each.bookkeeping?.(installed(each.id) ?? fallback) ?? [],
      )
    },
    /** Whether Novadeck's plugin is installed into the agent. */
    connected: async (agent: AgentName): Promise<boolean> => {
      const install = await installs()
      if (!install) return false
      const where = install(agent)
      const began = epoch(agent)
      let connected = await harnesses[agent].connected(where)
      // A connected agent read as disconnected is read again before it counts as lost.
      if (!connected && known.get(agent) === true && !changing.has(agent)) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.connectionConfirmMs ?? connectionConfirmMs).unref(),
        )
        connected = await harnesses[agent].connected(where)
      }
      if (epoch(agent) === began) note(agent, connected)
      return connected
    },
    /**
     * Follows each agent's connection: `listener` hears each change, whether the person's,
     * another client's or one outside Novadeck, which a look every `connectionPollMs` finds,
     * or any read of it first. Returns its end.
     */
    follow: (listener: (change: ConnectionChange) => void): (() => void) => {
      followers.add(listener)
      return () => void followers.delete(listener)
    },
    /**
     * Agents of `agent` asleep can't be woken, as it isn't connected: it counts as lost, as one
     * found gone would, though no look saw it connected first (a runner started after it
     * went). Nothing where it is connected, or lost already.
     */
    strand: (agent: AgentName): void => {
      if (known.get(agent) === true || changing.has(agent) || lost.has(agent)) return
      known.set(agent, false)
      lost.add(agent)
      log.warn(
        "harnesses.stranded",
        `Agents of ${agentLabel(agent)} sleep, but it isn't connected, so they can't be woken.`,
        { data: { agent } },
      )
      tell({ agent, connected: false, lost: true })
    },
    /** Whether the agent was found disconnected at its last look; false where it was never looked at. */
    disconnected: (agent: AgentName): boolean => known.get(agent) === false,
    /** The connected harnesses whose shims Novadeck's shells put first on PATH. */
    shims: async (): Promise<AgentName[]> => {
      const install = await installs()
      if (!install) return []
      const cmdShimDir = (await paths())?.cmdShimDir
      const machine = { ...(cmdShimDir !== undefined && { cmdShimDir }) }
      const shimmed = agents.filter(
        (agent) => (harnesses[agent].shims?.(platform, machine) ?? []).length > 0,
      )
      const connected = await Promise.all(
        shimmed.map((agent) => harnesses[agent].connected(install(agent))),
      )
      return shimmed.filter((_, index) => connected[index])
    },
    /**
     * Where each agent stands, by the login environment already read. With `fresh` it is
     * read again first, so a program the person has just installed shows once their PATH
     * says where it is; that spawns their login shell, so only the look after an install
     * asks for it.
     */
    list: async (look?: { readonly fresh?: boolean | undefined }): Promise<AgentIntegration[]> => {
      const install = await installs(
        look?.fresh === true && !closing.signal.aborted ? "fresh" : "latest",
      )
      if (!install) return agents.map((agent) => ({ agent, available: false, connected: false }))
      return Promise.all(
        agents.map((agent) => {
          const began = epoch(agent)
          return state(harnesses[agent], install(agent), (connected) => {
            // A loss counts only once confirmed (`connected`), which a look is asked for here.
            if (epoch(agent) === began && (connected || known.get(agent) !== true))
              note(agent, connected)
            else if (!connected) void api.connected(agent).catch(() => undefined)
            return !connected && lost.has(agent)
          })
        }),
      )
    },
    /** Installs or removes Novadeck's plugin in the agent; resolves to where it stands after. */
    set: (agent: AgentName, connected: boolean): Promise<AgentIntegration> => {
      const change = (wanted: boolean) =>
        own(agent, () => apply(agent, wanted)).then(
          (after) => {
            settled(agent, after.connected)
            return after
          },
          async (error: unknown) => {
            // Half done, it stands where its files say; never lost for Novadeck's own commands.
            const found = await api.connected(agent).catch(() => undefined)
            if (found !== undefined) settled(agent, found)
            throw error
          },
        )
      if (connected) return queued(() => change(true))
      // The person's disconnect stands from when it is asked for: a refresh queued ahead of
      // it leaves the agent alone, and a quit before it runs leaves no reinstall to finish.
      disconnecting.add(agent)
      void installs().then((install) =>
        install ? rm(reinstalling(install(agent)), { force: true }) : undefined,
      )
      return queued(() => change(false)).finally(() => disconnecting.delete(agent))
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
    refresh: async (gated = false): Promise<AgentName[]> => {
      const install = await installs()
      if (!install) return []
      const refreshed: AgentName[] = []
      for (const agent of agents) {
        const { installed } = harnesses[agent]
        // A copy that differs only with the shipping gate is looked at only while it is on, or
        // once it was switched (`gated`).
        if (!installed || (installed.gated === true && !gated)) continue
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
              // Its uninstall leaves it disconnected a moment: no loss of the person's.
              await own(agent, () => apply(agent, true))
            } finally {
              await rm(reinstalling(where), { force: true })
              // Done or failed, it stands where its files say: never lost by Novadeck's own commands.
              const now = await harnesses[agent].connected(where).catch(() => undefined)
              if (now !== undefined) settled(agent, now)
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
      clearInterval(polling)
      return Promise.resolve()
    },
  }
  // Each agent's connection is looked at every few seconds, so one lost outside Novadeck is
  // told (`follow`) while agents of it may sleep. Only while someone follows: the reads are
  // what tell them.
  const poll = () => {
    if (closing.signal.aborted || followers.size === 0) return
    for (const agent of agents) void api.connected(agent).catch(() => undefined)
  }
  const polling = setInterval(poll, options.connectionPollMs ?? connectionPollMs)
  polling.unref()
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
