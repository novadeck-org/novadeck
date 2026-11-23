import { writeFile } from "node:fs/promises"
import { constants as system } from "node:os"

import { spawn as nodePtySpawn } from "node-pty"

import { listedApart, type ApartProcess } from "./apart.js"
import { boosting, type Activity } from "./boost.js"
import {
  agentProcesses,
  endFollowed,
  processKey,
  type Followed,
  type Listing,
} from "./descendants.js"
import { terminalForeground } from "./foreground.js"
import { endLeftovers, leftovers, listedScope, readScope, runClock, runStart } from "./leftovers.js"
import type { Priority } from "./priority.js"
import type { ExitCause, Scopes } from "./scopes.js"
import { anyRunning, relayMs, taskkillTree, type Member } from "./trees.js"

/** Something to stop listening with: node-pty's and xterm's shape. */
export type Disposable = { dispose(): void }

/**
 * How a pty's program ended: its exit code, or the signal that ended it (null on Windows),
 * and why, where its platform says.
 */
export type PtyExit = {
  code: number | null
  signal: string | null
  cause?: ExitCause
}

/** node-pty's `IPty`, as far as a `Pty` uses it: what a test's stand-in plays. */
export type NativePty = {
  readonly pid: number
  readonly process: string
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (exit: { exitCode: number | undefined; signal?: number }) => void): Disposable
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(signal?: string): void
}

/** node-pty's `spawn`, as far as a `Pty` uses it. */
export type NativeSpawn = (
  file: string,
  args: string[] | string,
  options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: NodeJS.ProcessEnv
    useConptyDll: boolean
  },
) => NativePty

/**
 * How ptys start: node-pty's `spawn` unless a test plays one, the platform their ending
 * follows, where each program is kept apart from the app's, as `userScopes()` gives on Linux,
 * and how far its priority yields to the app's, as `terminalPriorities()` gives on macOS and
 * Windows. `trees` reads a Windows shell's programs, which may have started before its
 * priority could be lowered.
 */
export type PtyOptions = {
  readonly native?: NativeSpawn
  readonly platform?: NodeJS.Platform
  readonly scopes?: Scopes
  readonly priority?: Priority
  readonly trees?: Pick<ProcessTrees, "read">
  /**
   * Which terminal the person is using, as the host tells each pty its terminal's `id`: that
   * one's programs run at normal priority, and the others' stay lowered.
   */
  readonly activity?: Activity
  readonly id?: string
  /** The process list, for raising and lowering the programs a shell has started. */
  readonly listing?: Listing
}

/** A process's tree on Windows, read and ended as `Trees` does. */
export type ProcessTrees = {
  read(root: number | Member, timeoutMs?: number): Promise<readonly Member[] | undefined>
  end(members: readonly Member[], timeoutMs?: number): Promise<void>
}

/**
 * How long ending may take: `run(usual)` bounds one relay or taskkill run, `graceEnds(began)`
 * says until when what is left of a tree may end by itself. A host shutting down gives
 * less of both.
 */
export type EndBudget = {
  run(usual: number): number
  graceEnds(began: number): number
  /** When all ending must be done by, as a quit's own bound; none outside a quit. */
  by?(): number
}

/**
 * What ending what agents left in a terminal's scope reads (see `Pty.endLeft`): the processes,
 * and what the agents' harnesses run apart from the terminal, which is left with all under it.
 */
export type LeftOptions = {
  readonly listing: Listing
  readonly apart?: readonly ApartProcess[]
}

export type EndOptions = {
  /** How long the program has to end after its kill before it is forced, in milliseconds. */
  readonly graceMs: number
  /**
   * How long what it started has to end by itself: on Windows all its tree left running,
   * elsewhere what `follow` follows.
   */
  readonly treeGraceMs: number
  /** On Windows, the process trees, read before the kill and ended after. */
  readonly trees: ProcessTrees
  readonly budget?: EndBudget
  /**
   * On Linux and macOS, the agent the terminal runs, by its pid, and the processes, shared by
   * the terminals of a host: if it holds the foreground at the hangup, what it started is
   * waited for and ended as it is on Windows, by `budget`. What its harness runs apart from
   * the terminal (`apart`) is left, with all under it.
   */
  readonly follow?:
    | {
        readonly agent: number
        readonly listing: Listing
        readonly apart?: readonly ApartProcess[]
      }
    | undefined
  /**
   * On Linux, where an agent ran in the terminal (`Pty.agentStarted`), what it left in the
   * terminal's scope is ended too (see `Pty.endLeft`): as the hangup goes out, what has left the
   * shell's tree, and once the shell and what the follow waits on have ended, what is left.
   */
  readonly left?: LeftOptions | undefined
}

export type Pty = {
  /** Undefined until it is known: never 0, which on Windows would name the app itself. */
  readonly pid: number | undefined
  /** The name node-pty gives the foreground program (see `sampleForeground`). */
  readonly process: string
  /** Whether output has arrived: on Windows, a kill is queued until then. */
  readonly drawn: boolean
  /** Whether its exit has been reported. */
  readonly exited: boolean
  onData(listener: (data: string) => void): Disposable
  /** Its exit, reported once, whether the program's own or taken as one by `end`. */
  onExit(listener: (exit: PtyExit) => void): Disposable
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  /** Ends its program and what `EndOptions` say it started: the whole kill sequence. */
  end(options: EndOptions): Promise<void>
  /**
   * An agent runs in it now, by its pid where known: what starts in the terminal's scope from
   * then until `agentEnded` is the agent's, to end with the terminal (`endLeft`). On Linux with
   * a scope; elsewhere it records nothing. Told again while the run is open, it adds nothing.
   */
  agentStarted(agent: number | undefined): void
  /** The agent's session there has ended: what starts from now is no agent's. */
  agentEnded(): void
  /** Whether an agent has run in it, so `endLeft` may find something. */
  readonly agentRan: boolean
  /**
   * What agents left in the terminal's scope (see `leftovers`): what they started there,
   * detached or not, that no longer lies under the running shell. Undefined where the scope
   * or the processes can't be read.
   */
  leftovers(left: LeftOptions): Promise<readonly Followed[] | undefined>
  /**
   * Ends what agents left in the terminal's scope, as a close does once its shell has exited:
   * SIGTERM, then SIGKILL half a second on, or by `by()` (see `endLeftovers`). Nothing where no
   * agent ran there, or off Linux.
   */
  endLeft(left: LeftOptions, by?: () => number): Promise<void>
}

/** A signal number's name, such as `SIGKILL`; Windows has no signals. */
const signalName = (signal: number | undefined, platform: NodeJS.Platform): string | null => {
  if (!signal || platform === "win32") return null
  const entry = Object.entries(system.signals).find(([, value]) => value === signal)
  return entry?.[0] ?? null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resumes a process group hung up as its terminal closed, once the shell has exited. On
 * its own hangup bash takes the terminal back for itself before it exits, so a program
 * still restoring the terminal then, as an agent's TUI does on its way out, is stopped
 * by SIGTTIN or SIGTTOU. Should that stop not have finished as bash exits, the kernel
 * doesn't send the orphaned group its SIGHUP and SIGCONT, and the program stays stopped
 * for good. Once the shell is gone the terminal answers with an error instead, so the
 * resumed program finishes exiting. A group already gone is skipped.
 */
const resumeGroup = (group: number): boolean => {
  try {
    process.kill(-group, "SIGCONT")
    return true
  } catch {
    // Gone.
    return false
  }
}

/**
 * `resumeGroup` now and every 100 ms for a second more while the group is there. A program
 * that stops itself in user space, as one finishing its hangup handler does, may do so just
 * after the one resume found it running: a resume sent to a running process is lost, and it
 * would stay stopped until the end's bound. The timers don't keep the process alive.
 */
const resumeGroupRepeatedly = (group: number): void => {
  if (!resumeGroup(group)) return
  let left = 10
  const timer = setInterval(() => {
    left -= 1
    if (left <= 0 || !resumeGroup(group)) clearInterval(timer)
  }, 100)
  timer.unref()
}

/**
 * Ends a program its first kill left running. On Windows, which has no signals, node-pty
 * throws on one, and later still when it queued the kill until the terminal first drew:
 * its process and every program it started are ended by its id instead. Until its output
 * connects, node-pty names that id 0, which would end the app itself, so it rejects, and
 * the program is taken as ended while node-pty's queued kill closes its console later.
 */
export const forceKill = async (
  child: { readonly pid: number | undefined; kill(signal?: string): void },
  platform: NodeJS.Platform,
  end: (pid: number) => Promise<void> | void = taskkillTree,
): Promise<void> => {
  if (platform !== "win32") return child.kill("SIGKILL")
  if (child.pid === undefined) throw new Error("The program has no process id yet.")
  await end(child.pid)
}

// Hangs up the program in the terminal's foreground, as closing a real terminal does, and
// returns its process group; undefined when there is none to hang up, as on Windows,
// where no foreground group is known. A shell passes its own hangup on to the jobs it
// started, but not always: bash does not to a command its prompt hook ran, which would
// then run on without a terminal. `foreground` spares asking where a listing has told.
const hangUp = async (
  pid: number | undefined,
  foreground?: number,
): Promise<number | undefined> => {
  if (pid === undefined) return undefined
  const group = foreground ?? (await terminalForeground(pid))
  if (group === undefined || group === pid) return undefined
  try {
    process.kill(-group, "SIGHUP")
  } catch {
    // Gone meanwhile.
  }
  return group
}

// Ends a Windows process and every one under it now, by taskkill where the trees can't.
const endTreeNow = async (pid: number, trees: ProcessTrees): Promise<void> => {
  const tree = await trees.read(pid)
  if (tree === undefined) return taskkillTree(pid)
  await trees.end(tree)
}

// Ends what is left of a closed terminal's process tree once it has had its grace to end
// by itself: the tree read before the close, and what its members started since, as an
// agent's hook run as it closes, or left running as they ended, read again from each by
// its start.
const endTreeLeft = async (
  tree: readonly Member[],
  trees: ProcessTrees,
  budget: EndBudget,
): Promise<void> => {
  const began = Date.now()
  while (anyRunning(tree) && Date.now() < budget.graceEnds(began))
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await sleep(100)
  const again = await Promise.all(tree.map((member) => trees.read(member, budget.run(relayMs))))
  const left = new Map(
    [...tree, ...again.flatMap((each) => each ?? [])].map((member) => [
      `${member.pid}:${member.startedAt}`,
      member,
    ]),
  )
  const members = [...left.values()]
  if (!anyRunning(members)) return
  await trees.end(members, budget.run(relayMs))
  // A pid that still answers a moment later is said, so a process the trees didn't end,
  // as where a run ran out of time, shows. Nothing more is ended by pid alone: another
  // process may have taken one meanwhile, which the trees rightly refused.
  await sleep(200)
  const answering = members.filter((member) => anyRunning([member]))
  if (answering.length > 0)
    console.error(
      "After ending a closed terminal's processes, these pids still answer, each that process or one given its pid since:",
      answering.map(({ pid, startedAt }) => `${pid} (started ${startedAt})`).join(", "),
    )
}

/**
 * How long a Windows shell's pid is waited for, to put it in its job: node-pty names it as it
 * creates the shell, once its console's output pipe connects, or 5 s on if that never does.
 */
const pidWaitMs = 6_000

const usualBudget = (treeGraceMs: number): EndBudget => ({
  run: (usual) => usual,
  graceEnds: (began) => began + treeGraceMs,
})

/**
 * Starts `file` in a pty of `cols` by `rows`, as an `xterm-256color` terminal. `args` is
 * its arguments, or on Windows its whole command line as one string, as cmd needs one.
 * `platform` decides how it ends (by default the one it runs on); `native` is node-pty's
 * `spawn` unless a test plays one; `scopes` takes the program in as it starts. A program
 * that may have been killed for memory has its exit reported once its scope says why.
 */
export const spawnPty = (
  options: {
    file: string
    args: readonly string[] | string
    cwd: string
    env: NodeJS.ProcessEnv
    cols: number
    rows: number
    /**
     * On Windows, a file made once the shell's job has settled, whether it got there or not,
     * which its startup command waits for (`ShellLaunch.scopeFile`).
     */
    scopeFile?: string | undefined
  } & PtyOptions,
): Pty => {
  const platform = options.platform ?? process.platform
  const native: NativeSpawn = options.native ?? nodePtySpawn
  const { args } = options
  const child = native(options.file, typeof args === "string" ? args : [...args], {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    // Windows' built-in console host can lose input; node-pty ships a newer one. Ending
    // relies on it too: with it, node-pty's kill closes the pseudoconsole, which sends its
    // programs CTRL_CLOSE_EVENT, and ends only the shell (see `end`); without it, it ends
    // everything on the console at once.
    useConptyDll: platform === "win32",
  })
  // Its scope, asked for as it starts; a Windows shell's job once node-pty names its pid (below).
  let scope = child.pid > 0 && platform !== "win32" ? options.scopes?.contain(child.pid) : undefined
  const boost = boosting({
    scope,
    priority: options.priority,
    platform,
    shell: () => (child.pid > 0 ? child.pid : undefined),
    running: () => !exited,
    ...(options.trees && { trees: options.trees }),
    ...(options.listing && { listing: options.listing }),
  })
  let drawn = false
  // macOS names the shell's pid at once, so it is lowered before it can start anything. On
  // Windows node-pty's public `pid` stays 0 until its data pipe connects, by which time the
  // shell may be running its startup command; the first output follows the pid. So there the
  // shell is lowered then, and what it started by then once the relay has read its tree (a
  // process to spawn, a snapshot, a call per pid: hundreds of ms, up to `relayMs` on a cold
  // machine). Whatever those started meanwhile stays at normal, and with no relay only the
  // shell is lowered. Between the snapshot and a call a member can exit and Windows reuse its
  // pid, so the call may lower an unrelated process, as `setPriority` can't check which it
  // hits, unlike a kill by pid and start. Accepted: the window is that short, a reused pid
  // being likelier a recent one, and the harm one process running a little slower.
  if (platform === "win32") {
    let lowered = false
    child.onData(() => {
      if (lowered || !(child.pid > 0)) return
      lowered = true
      // Its terminal in use already: raised now, as it couldn't be while its pid was unknown.
      if (boost.active) return boost.known()
      const shell = child.pid
      options.priority?.lower(shell)
      if (options.priority)
        void options.trees
          ?.read(shell)
          .then((tree) => {
            // Its terminal came into use while the tree was read: the raise reads its own,
            // which may have come back first, and a lowering now would undo it.
            if (boost.active) return
            for (const member of tree ?? [])
              if (member.pid !== shell) options.priority?.lower(member.pid)
          })
          .catch(() => {})
    })
  } else if (child.pid > 0) options.priority?.lower(child.pid)
  let exited = false
  let ending = false
  // node-pty's exit came, its fd closed, while the report may wait for its cause.
  let gone = false
  // On Windows node-pty names the shell's pid only once it has created it, a moment after
  // `spawn` returns: the shell goes into its job then (see `windowsJobs`). What it started
  // before it got there stays out, so its startup command waits for `scopeFile`, made once
  // that has settled either way.
  if (platform === "win32" && options.scopes) {
    const scopes = options.scopes
    const settled = (held: Promise<boolean>) => {
      const file = options.scopeFile
      if (file !== undefined) void held.then(() => writeFile(file, "")).catch(() => {})
    }
    const contain = () => {
      if (child.pid > 0 && !gone) {
        scope = scopes.contain(child.pid)
        settled(scope.held ?? Promise.resolve(true))
      } else settled(Promise.resolve(false))
    }
    if (child.pid > 0) contain()
    else {
      const began = Date.now()
      const watch = setInterval(() => {
        if (child.pid > 0 || gone || Date.now() - began > pidWaitMs) {
          clearInterval(watch)
          contain()
        }
      }, 1)
      watch.unref?.()
    }
  }
  const exitListeners = new Set<(exit: PtyExit) => void>()
  // Told at once whether its terminal is in use, and on each change until it exits.
  const stopActivity =
    options.activity && options.id !== undefined
      ? options.activity.register(options.id, boost.set)
      : undefined
  const report = (exit: PtyExit) => {
    if (exited) return
    exited = true
    stopActivity?.()
    for (const listener of exitListeners) listener(exit)
  }
  let resolveExit: (() => void) | undefined
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  // Before any listener, so a terminal has drawn by the time its first output is handled.
  child.onData(() => {
    drawn = true
  })
  // node-pty can report an exit before it learns the code, e.g. after ending a Windows
  // terminal whose input failed.
  child.onExit(({ exitCode, signal }) => {
    gone = true
    // A scope its program was moved into as it died stays empty, and active, for ever.
    void scope?.exited()
    const ended = {
      code: signal ? null : (exitCode ?? null),
      signal: signalName(signal, platform),
    }
    // Why it ended is looked up only where nothing here ended it.
    const cause = ending ? undefined : scope?.cause(ended.signal)
    if (!cause) return report(ended)
    void cause.then((found) => report(found ? { ...ended, cause: found } : ended))
  })
  exitListeners.add(() => resolveExit?.())
  // An exit taken as one, where the program's own may never be reported.
  const takenAsEnded = () => report({ code: null, signal: null })

  // Agents' runs in the terminal, kept where its scope can say what they left (Linux, Windows).
  const runs: { since: number; until?: number }[] = []
  const tracksRuns = () => (platform === "linux" || platform === "win32") && scope !== undefined
  // Now, in the clock a process's start is listed in.
  const clock = () => runClock(platform)
  // What agents left in the scope now; `skip` leaves out what a follow still waits on.
  const findLeft =
    (left: LeftOptions, skip?: ReadonlySet<string>) =>
    async (): Promise<readonly Followed[] | undefined> => {
      const held = scope
      if (!held || runs.length === 0) return undefined
      const read = held.listed
        ? await listedScope(held.listed.bind(held))
        : await readScope(left.listing, () => held.members())
      if (!read) return undefined
      return leftovers({
        rows: read.rows,
        members: read.members,
        runs,
        // The running shell's tree is the hangup's and the follow's, not this.
        shell: gone ? undefined : pty.pid,
        apart: listedApart(read.rows, left.apart ?? [], platform),
        ...(skip && { skip }),
      })
    }
  // Ends what agents left there, as a close does, after which nothing reads the scope again.
  const endLeft = async (left: LeftOptions, by?: () => number): Promise<void> => {
    try {
      if (runs.length > 0) await endLeftovers(findLeft(left), by, scope?.end?.bind(scope))
    } finally {
      scope?.done?.()
    }
  }

  const pty: Pty = {
    get pid() {
      // Windows names the process 0 until its output connects.
      return child.pid > 0 ? child.pid : undefined
    },
    get process() {
      return child.process
    },
    get drawn() {
      return drawn
    },
    get exited() {
      return exited
    },
    onData: (listener) => child.onData(listener),
    onExit: (listener) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    // Nothing reaches a program that is gone: its fd may name another's by now.
    write: (data) => {
      if (!gone) child.write(data)
    },
    resize: (cols, rows) => {
      if (!gone) child.resize(cols, rows)
    },
    pause: () => {
      if (!gone) child.pause()
    },
    resume: () => {
      if (!gone) child.resume()
    },
    end: async ({
      graceMs,
      treeGraceMs,
      trees,
      budget = usualBudget(treeGraceMs),
      follow,
      left,
    }) => {
      ending = true
      const by = () => budget.by?.() ?? Number.POSITIVE_INFINITY
      // Gone, its exit waiting for its cause: no signal for its pid, which may be another's.
      if (gone) {
        await exit
        if (left) await endLeft(left, by)
        scope?.done?.()
        return
      }
      const began = Date.now()
      // The second signal bounds ending even for programs that ignore SIGHUP.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Before the hangup, while what the agent started still leads back to it. A listing
        // has a limit of its own, and past it the hangup goes ahead: it matters more.
        const following =
          follow && pty.pid !== undefined && platform !== "win32" ? follow : undefined
        const rows = following && (await following.listing())
        if (following && !rows)
          console.error(
            "Listing the processes failed, so what this terminal's agent started won't be followed:",
            pty.pid,
          )
        if (gone) return await exit
        const followed =
          following &&
          rows &&
          agentProcesses(
            rows,
            pty.pid!,
            following.agent,
            listedApart(rows, following.apart ?? [], platform),
          )
        // Windows has no process groups to hang up.
        const shell = rows?.find((row) => row.pid === pty.pid)
        const group =
          platform === "win32"
            ? undefined
            : await hangUp(pty.pid, shell && shell.foreground > 0 ? shell.foreground : undefined)
        // Windows hangs up no group: closing the console sends what is attached to it
        // CTRL_CLOSE_EVENT, and node-pty ends the shell, but nothing reaches what a program
        // there started apart from it, as an agent's hooks in consoles of their own, which
        // then run on. The tree is read first, while it still leads back to its shell, and
        // what of it outlives the console's close by `treeGraceMs` is ended. Not once the
        // program has exited: its id may name another process by now. Where the trees can't
        // be read, taskkill ends the tree at once.
        const pid = pty.pid
        const owned = platform === "win32" && pid !== undefined && drawn && !exited
        const tree = owned ? await trees.read(pid, budget.run(relayMs)) : undefined
        if (owned && tree === undefined) await taskkillTree(pid, budget.run(5_000)).catch(() => {})
        try {
          child.kill()
        } catch {
          takenAsEnded()
        }
        timer = setTimeout(() => {
          // Gone while what it left is still waited for: its pid may be another's by now.
          if (gone) return
          // A Windows terminal that has drawn ran node-pty's kill, which ended its shell,
          // whose id may already name another process.
          const forced =
            platform === "win32" && drawn
              ? Promise.resolve()
              : forceKill(
                  { pid: pty.pid, kill: (signal) => child.kill(signal) },
                  platform,
                  (each) => endTreeNow(each, trees),
                )
          forced.then(
            // node-pty on Windows reports an exit only once the console closes, which a
            // program the kill could not end can still keep open.
            () => {
              if (platform === "win32") takenAsEnded()
            },
            takenAsEnded,
          )
        }, graceMs)
        await Promise.all([
          // As soon as the shell has gone, however long what it left is waited for.
          exit.then(() => {
            if (group !== undefined) resumeGroupRepeatedly(group)
          }),
          tree && endTreeLeft(tree, trees, budget),
          following &&
            followed &&
            endFollowed(followed, () => budget.graceEnds(began), following.listing),
          // What an agent left outside the shell's tree has no hangup coming, nor anything to
          // wait for: ended at once, but for what the follow gives its grace.
          left &&
            runs.length > 0 &&
            endLeftovers(
              findLeft(left, new Set((followed ?? []).map(processKey))),
              by,
              scope?.end?.bind(scope),
            ),
        ])
        // What is left once the shell has gone: what was under it, as a `nohup` of the
        // agent's, and what started meanwhile, as a hook's as the agent ended.
        if (left) await endLeft(left, by)
      } finally {
        if (timer) clearTimeout(timer)
        // Closed: nothing reads its scope again.
        scope?.done?.()
      }
    },
    agentStarted: (agent) => {
      if (!tracksRuns()) return
      let run = runs.at(-1)
      if (!run || run.until !== undefined) {
        const now = clock()
        if (now === undefined) return
        run = { since: now }
        runs.push(run)
      }
      // From the agent's own start where the listing shows it, as it may have started its
      // helpers before it bound; the time it bound stands only where it can't be read. A
      // Windows job lists its own, which no listing sees.
      const held = scope
      const listing = held?.listed ? () => held.listed!() : options.listing
      if (agent === undefined || !listing) return
      const open = run
      void listing()
        .then((rows) => {
          const start = rows && runStart(rows, agent)
          if (start !== undefined && open.until === undefined) open.since = start
        })
        .catch(() => {})
    },
    agentEnded: () => {
      const run = runs.at(-1)
      if (run && run.until === undefined) run.until = Math.max(run.since, clock() ?? run.since)
    },
    get agentRan() {
      return runs.length > 0
    },
    leftovers: (left) => (runs.length === 0 ? Promise.resolve([]) : findLeft(left)()),
    endLeft,
  }
  return pty
}
