import { constants as system } from "node:os"

import { spawn as nodePtySpawn } from "node-pty"

import { terminalForeground } from "./foreground.js"
import type { ExitCause, Scopes } from "./scopes.js"
import { anyRunning, relayMs, taskkillTree, type Member } from "./trees.js"

/** Something to stop listening with: node-pty's and xterm's shape. */
export type Disposable = { dispose(): void }

/**
 * How a pty's program ended: its exit code, or the signal that ended it (null on Windows),
 * and why, where its platform says.
 */
export type PtyExit = { code: number | null; signal: string | null; cause?: ExitCause }

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
 * follows, and where each program is kept apart from the app's, as `userScopes()` gives on Linux.
 */
export type PtyOptions = {
  readonly native?: NativeSpawn
  readonly platform?: NodeJS.Platform
  readonly scopes?: Scopes
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
}

export type EndOptions = {
  /** How long the program has to end after its kill before it is forced, in milliseconds. */
  readonly graceMs: number
  /** On Windows, how long what its tree left running has to end by itself. */
  readonly treeGraceMs: number
  /** On Windows, the process trees, read before the kill and ended after. */
  readonly trees: ProcessTrees
  readonly budget?: EndBudget
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
  /** Ends its program and, on Windows, what it started: the whole kill sequence. */
  end(options: EndOptions): Promise<void>
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
const resumeGroup = (group: number): void => {
  try {
    process.kill(-group, "SIGCONT")
  } catch {
    // Gone.
  }
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
// then run on without a terminal.
const hangUp = async (pid: number | undefined): Promise<number | undefined> => {
  if (pid === undefined) return undefined
  const group = await terminalForeground(pid)
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
const endLeft = async (
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
  const scope = child.pid > 0 ? options.scopes?.contain(child.pid) : undefined
  let drawn = false
  let exited = false
  let ending = false
  // node-pty's exit came, its fd closed, while the report may wait for its cause.
  let gone = false
  const exitListeners = new Set<(exit: PtyExit) => void>()
  const report = (exit: PtyExit) => {
    if (exited) return
    exited = true
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
    const ended = { code: signal ? null : (exitCode ?? null), signal: signalName(signal, platform) }
    // Why it ended is looked up only where nothing here ended it.
    const cause = ending ? undefined : scope?.cause(ended.signal)
    if (!cause) return report(ended)
    void cause.then((found) => report(found ? { ...ended, cause: found } : ended))
  })
  exitListeners.add(() => resolveExit?.())
  // An exit taken as one, where the program's own may never be reported.
  const takenAsEnded = () => report({ code: null, signal: null })

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
    end: async ({ graceMs, treeGraceMs, trees, budget = usualBudget(treeGraceMs) }) => {
      ending = true
      // Gone, its exit waiting for its cause: no signal for its pid, which may be another's.
      if (gone) return exit
      // The second signal bounds ending even for programs that ignore SIGHUP.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Windows has no process groups to hang up.
        const group = platform === "win32" ? undefined : await hangUp(pty.pid)
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
        await Promise.all([exit, tree && endLeft(tree, trees, budget)])
        if (group !== undefined) resumeGroup(group)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
  return pty
}
