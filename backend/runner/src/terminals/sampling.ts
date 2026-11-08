import { basename } from "node:path"

import { harnesses, type AgentName, type ForegroundProcess } from "@novadeck/protocol"
import {
  chainTo,
  hasChildProcess,
  hasJobUnder,
  hasTerminalChild,
  processTable,
  sampleForeground,
  tableForeground,
  terminalForeground,
  type Member,
  type TableRow,
} from "@novadeck/terminal/pty"

import { agentProcess } from "./ending.js"
import type { Record } from "./record.js"

/** What sampling reads of a terminal's record, and what it keeps there. */
export type SampledRecord = Pick<
  Record,
  | "terminal"
  | "foreground"
  | "summary"
  | "changed"
  | "bound"
  | "endKeyAt"
  | "ending"
  | "woken"
  | "shellName"
  | "hibernating"
>

// Whether the platform hides a terminal's foreground program, as Windows does: no sample
// names it there.
const foregroundHidden = (): boolean => process.platform === "win32"

/**
 * How long before an agent's end the person's Ctrl+C or Ctrl+D may have come for the end
 * to be theirs: they quit an agent within moments of the key.
 */
export const exitKeysMs = 5_000

/**
 * How many samples a Windows terminal's agent that ended without such a key waits before it
 * counts as ended (its resume and lead let go): 30 of them, 30 s as sampled by default. A
 * shutdown ends every console program with nobody at the keys, and the app then saves its
 * pages (1.5 s at most) and closes the runner (killed after 5 s), so the runner is gone well
 * within it; an agent that really ended, as by a crash, a one-shot run or a slow `/exit`,
 * only counts later than elsewhere.
 */
export const graceSamples = 30

/**
 * How many samples the system's word that the session is ending (the app's `persist`)
 * holds: 900, 15 minutes as sampled by default. Long enough for a shutdown screen that
 * waits on apps, short enough that a shutdown the person cancels stops holding.
 */
export const endingSamples = 900

/** Whether the system said lately that it is ending the session, so no agent's end counts yet. */
export const sessionEnding = (record: Pick<Record, "ending">, pollMs: number): boolean =>
  record.ending !== undefined && Date.now() - record.ending < endingSamples * pollMs

/**
 * Runs `decide` once an agent's end counts (see `endWaitMs`), and only once the system's
 * word that the session is ending has lapsed: held back while it stands, so an end during a
 * shutdown that was cancelled is decided afterwards, not lost.
 */
export const whenEndCounts = (
  record: Pick<Record, "endKeyAt" | "ending">,
  pollMs: number,
  decide: () => void,
): void => {
  const fire = (): void => {
    if (record.ending !== undefined && sessionEnding(record, pollMs)) {
      const left = record.ending + endingSamples * pollMs - Date.now()
      setTimeout(fire, Math.max(pollMs, left)).unref()
      return
    }
    decide()
  }
  setTimeout(fire, endWaitMs(record, pollMs)).unref()
}

/**
 * How long after an agent's end, where no sample names the foreground program (Windows),
 * it counts as ended: a sample's time after the person's own ending key just before, else
 * the grace. The one decision of every path that ends an agent there.
 */
export const endWaitMs = (record: Pick<Record, "endKeyAt">, pollMs: number): number =>
  record.endKeyAt !== undefined && Date.now() - record.endKeyAt <= exitKeysMs
    ? pollMs
    : pollMs * graceSamples

/**
 * An agent's session bound the terminal. Where no sample names the foreground program,
 * the agent is the program a fresh shell resumes, should this one be lost; the sampler
 * says so elsewhere, once it has sampled: an agent that binds and stops within a sample's
 * time (a poll is a second) would leave no program at all, so a terminal with none yet
 * takes the agent. Whether that changed it, which the caller saves.
 */
export const boundProgram = (
  record: Pick<Record, "summary" | "changed">,
  agent: AgentName,
): boolean => {
  const { lastProgram } = record.summary
  if (lastProgram === agent || (!foregroundHidden() && lastProgram !== null)) return false
  record.summary = { ...record.summary, lastProgram: agent }
  record.changed = true
  return true
}

/**
 * The program a foreground process is, as a fresh shell resumes it: its name, or for Node
 * the agent whose script it runs (an npm-installed Codex is `node` to the system).
 */
export const programOf = (process: ForegroundProcess): string => {
  if (process.name !== "node" && process.name !== "nodejs") return withoutExe(process.name)
  const script = (process.argv?.[1] ?? "").replaceAll("\\", "/")
  const found = harnesses.find(
    ({ id, nodeScript }) =>
      script.split("/").at(-1) === id || (nodeScript !== undefined && script.endsWith(nodeScript)),
  )
  return found?.id ?? process.name
}

// A program's name without the `.exe` an npm-installed native binary carries on every OS.
const withoutExe = (name: string): string => name.replace(/\.exe$/i, "")

/**
 * The program a sample names for a record: `programOf`, and where the platform tells no
 * command line (macOS), any program but the shell in the foreground while an agent's
 * session is bound is that agent. macOS names a process after its real file, which for
 * Claude Code is `claude.exe` from npm or its version (`2.1.319`) from its installer, and
 * for an npm Codex `node`. A program left running after the binding ended keeps its name.
 */
const sampledProgram = (
  process: ForegroundProcess,
  record: Pick<Record, "bound" | "shellName">,
): string => {
  const program = programOf(process)
  const bound = record.bound?.binding.agent
  if (bound === undefined || process.argv !== null) return program
  const shell = record.shellName === undefined ? undefined : withoutExe(basename(record.shellName))
  return program.replace(/^-/, "") === shell ? program : bound
}

export type SamplerHost<R extends SampledRecord> = {
  /** The runner is stopping: no sampling starts. */
  readonly stopping: () => boolean
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<R>
  /** A terminal's foreground program changed, kept in its summary and marked unsaved. */
  readonly sampled: (record: R) => void
}

// Whether the shell holds its terminal's foreground, as at its prompt: by the foreground
// process group where the platform tells it, so a script its own interpreter runs (`bash
// deploy.sh`) is a program; else by the foreground program's name, and, with none told (as
// on Windows), it does.
export const shellAtPrompt = (
  record: Pick<Record, "foreground" | "terminal" | "summary" | "shellName">,
): boolean => {
  const group = record.foreground?.group
  if (group !== undefined && group !== null) return group === record.terminal.pty.pid
  const name = record.summary.process?.name
  return name === undefined || record.shellName === undefined || name === record.shellName
}

/**
 * Whether a program may be running in the terminal's shell, for a close that must not end
 * work unasked: one holds the foreground; or, where the shell's integration reported a
 * prompt, a line was entered whose prompt hasn't come back (what Windows, which names no
 * foreground program, tells); or the shell has a live child, as a job in the background.
 * Without integration `submitted` never resets, so it counts for nothing there.
 */
export const shellBusy = async (
  record: BusyRecord,
  trees?: Parameters<typeof hasChildProcess>[1],
): Promise<boolean> => {
  // The foreground read now, where the platform tells it: the last sample may predate a
  // program that has ended since.
  const group = await terminalForeground(record.terminal.pty.pid)
  if (group !== undefined ? group !== record.terminal.pty.pid : !shellAtPrompt(record)) return true
  if (record.prompts.length > 0 && record.submitted) return true
  return (await hasChildProcess(record.terminal.pty.pid, trees)) === true
}

type BusyRecord = Pick<
  Record,
  "foreground" | "terminal" | "summary" | "shellName" | "prompts" | "submitted"
>

/** What `busyTerminals` found: the terminals that hold work, and those it couldn't read. */
export type BusyShells = { readonly busy: string[]; readonly unknown: string[] }

/** Whether an agent runs, or is expected, in the record's terminal. */
const runsAgent = ({ summary, bound }: Pick<Record, "summary" | "bound">): boolean =>
  bound !== null || summary.agent !== null || summary.ready !== null || summary.startup !== null

const usable = (pid: number | undefined): pid is number =>
  pid !== undefined && Number.isSafeInteger(pid) && pid > 0

/**
 * Whether the shell of a terminal that runs an agent holds work of its own: a child on the
 * shell's terminal that is not the agent's, as `pnpm dev &` typed before `claude`, or a
 * suspended agent's program. Where the table lists processes, the agent and any wrapper
 * around it are the foreground group's leader, which is left out; where it does not
 * (Windows), the chain from the shell to the agent and the agent's own processes are, as
 * hibernation reads them, or, where the agent's process isn't known (before its first prompt,
 * on its startup screen), the shell's children but for those named after a harness's program and
 * what they run. Undefined where it can't tell.
 */
const agentShellJobs = async (
  record: Record,
  pid: number,
  table: readonly TableRow[] | undefined,
  trees: Parameters<typeof hasChildProcess>[1],
): Promise<boolean | undefined> => {
  if (process.platform === "win32") {
    const all = await trees?.read(pid)
    if (!all) return undefined
    const agent = agentProcess(record)
    if (agent === undefined) {
      // No agent process known, as before its first prompt or on its startup screen: what
      // the shell started, but for the harness's own program and what it started, is a job.
      return hasJobUnder(all, pid, harnessMembers(all))
    }
    const own = await trees?.read(agent)
    if (!own) return undefined
    const chain = chainTo(all, pid, agent) ?? []
    return hasJobUnder(all, pid, new Set([...own.map((member) => member.pid), ...chain]))
  }
  if (!table) return undefined
  const group = tableForeground(table, pid)
  if (group === undefined) return undefined
  return hasTerminalChild(table, pid, new Set(group === pid ? [] : [group]))
}

const harnessPrograms: ReadonlySet<string> = new Set(harnesses.map(({ id }) => id))

/**
 * The pids of a Windows tree's members named after a harness's program (`codex.exe`) and of
 * everything below them: the agent as far as its name tells, and what it runs.
 */
const harnessMembers = (tree: readonly Member[]): ReadonlySet<number> => {
  const own = new Set(
    tree.flatMap(({ pid, name }) =>
      name !== undefined && harnessPrograms.has(withoutExe(name.toLowerCase())) ? [pid] : [],
    ),
  )
  for (let grew = true; grew;) {
    grew = false
    for (const { pid, parent } of tree)
      if (parent !== undefined && own.has(parent) && !own.has(pid)) {
        own.add(pid)
        grew = true
      }
  }
  return own
}

/**
 * The terminals whose shell holds work a close would end, as `shellBusy` says it for one, and
 * those it couldn't read, for every terminal given at once. A shell without an agent is busy
 * for a program in its foreground, a line entered and not finished, or a job in the
 * background or suspended; one with an agent, for a job of its own beside the agent
 * (`agentShellJobs`). The system's processes are listed once for all of them, on Linux and
 * macOS together with each shell's foreground group, and read when asked: nothing samples
 * it. A read that failed is `unknown`, never "not busy": no listing makes every shell
 * unknown. A terminal whose shell has ended or hasn't started is neither.
 */
export const busyTerminals = async (
  records: Iterable<Record>,
  trees?: Parameters<typeof hasChildProcess>[1],
): Promise<BusyShells> => {
  const shells = [...records].filter(
    ({ terminal }) => terminal.exit === null && !terminal.exiting && usable(terminal.pty.pid),
  )
  const table = await processTable()
  const found = await Promise.all(
    shells.map(async (record): Promise<boolean | undefined> => {
      const pid = record.terminal.pty.pid!
      if (runsAgent(record)) return agentShellJobs(record, pid, table, trees)
      if (process.platform === "win32") {
        // No foreground group to read: a program is a line entered, or a job in the tree.
        if (!shellAtPrompt(record) || (record.prompts.length > 0 && record.submitted)) return true
        return hasChildProcess(pid, trees)
      }
      if (!table) return undefined
      const group = tableForeground(table, pid)
      if (group !== undefined ? group !== pid : !shellAtPrompt(record)) return true
      if (record.prompts.length > 0 && record.submitted) return true
      return hasTerminalChild(table, pid)
    }),
  )
  return {
    busy: shells.flatMap(({ summary }, index) => (found[index] === true ? [summary.id] : [])),
    unknown: shells.flatMap(({ summary }, index) =>
      found[index] === undefined ? [summary.id] : [],
    ),
  }
}

/**
 * `busyTerminals` over `records`, shared as `shared` says: the read behind the runner's
 * `terminals.busy`, which several windows may ask at once.
 */
export const busyReader = (
  records: () => Iterable<Record>,
  trees: () => Parameters<typeof hasChildProcess>[1],
): Shared<BusyShells> => shared(() => busyTerminals(records(), trees()))

/** A read callers share: see `shared`. */
export type Shared<T> = {
  /** The read in flight, or a new one: calls that overlap share it. */
  readonly read: () => Promise<T>
  /** A read that starts after this call: after the one in flight, shared by every call that waits so. */
  readonly fresh: () => Promise<T>
}

/**
 * `read` as one in flight at a time, so several windows asking at once cost one read of the
 * system. An answer for a caller that is about to act (`fresh`) must not be one that began
 * before it asked, since what it looked at may have changed since: it waits for the read in
 * flight, then has one of its own, which later fresh callers share until it starts.
 */
export const shared = <T>(read: () => Promise<T>): Shared<T> => {
  let flying: Promise<T> | undefined
  let queued: Promise<T> | undefined
  const start = (): Promise<T> => {
    const run = read().finally(() => {
      if (flying === run) flying = undefined
    })
    flying = run
    return run
  }
  return {
    read: () => flying ?? start(),
    fresh: () => {
      if (!flying) return start()
      queued ??= flying
        .catch(() => undefined)
        .then(() => {
          queued = undefined
          return start()
        })
      return queued
    },
  }
}

/**
 * Whether a program runs in the terminal's shell besides its prompt, on every OS: one holds
 * the foreground (an agent too), or, where the shell's integration reported a prompt, a line
 * was entered whose prompt hasn't come back, which is all Windows, naming no foreground
 * program, can tell. Unlike `shellBusy` it reads no process, so a summary can carry it.
 */
export const programRuns = (
  record: Pick<
    Record,
    "foreground" | "terminal" | "summary" | "shellName" | "prompts" | "submitted" | "startupRuns"
  >,
): boolean =>
  record.terminal.exit === null &&
  !record.terminal.exiting &&
  (!shellAtPrompt(record) ||
    // A command the shell was started with, which runs before its first prompt.
    record.startupRuns ||
    (record.prompts.length > 0 && record.submitted))

/** Keeps `programRuns` in the terminal's summary; whether that changed it. */
export const markBusy = (
  record: Pick<
    Record,
    "foreground" | "terminal" | "summary" | "shellName" | "prompts" | "submitted" | "startupRuns"
  >,
): boolean => {
  const busy = programRuns(record)
  if (busy === record.summary.busy) return false
  record.summary = { ...record.summary, busy }
  return true
}

/** The shell until the first sample, which may add its command line; Windows reports none. */
export const shellProcess = (shell: string): ForegroundProcess | null => {
  const name = basename(shell).slice(0, 256)
  return process.platform === "win32" || !name ? null : { name, argv: null }
}

const sameProcess = (a: ForegroundProcess | null, b: ForegroundProcess | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.name === b.name &&
    a.argv?.length === b.argv?.length &&
    (a.argv ?? []).every((arg, index) => arg === b.argv?.[index]))

/** Samples running terminals' foreground processes, while some terminal runs. */
export class Sampler<R extends SampledRecord> {
  private sampler: ReturnType<typeof setInterval> | undefined

  constructor(
    /** How often running terminals' foreground processes are sampled, in milliseconds. */
    private readonly pollMs: number,
    readonly host: SamplerHost<R>,
  ) {}

  /** Starts sampling foreground processes, which continues while some terminal runs. */
  start(): void {
    if (this.sampler || this.host.stopping() || foregroundHidden()) return
    this.sampler = setInterval(() => this.sample(), this.pollMs)
    this.sampler.unref()
  }

  /**
   * The shell showed its prompt. Where no sample names the foreground program, the agent
   * `boundProgram` named is no longer the one to resume, but only once the shell has held
   * its prompt for a sample's time, as a sample would tell. An agent ended just before its
   * shell, as Windows ends every console program while it shuts down, has its shell show a
   * prompt for the moment before the runner stops: that agent stays the one to resume. An
   * agent bound again meanwhile, the shell ended or replaced, or the runner stopping keeps
   * it too. The wait is a sample's time after the person's own ending key, else the grace
   * (see `endWaitMs`), and the system's word that the session is ending holds it back
   * (see `whenEndCounts`).
   */
  prompted(record: R): void {
    // A woken shell with nothing bound yet keeps its program: the agent may only have failed.
    if (!foregroundHidden() || record.summary.lastProgram === null || record.woken) return
    const shell = record.terminal.pty
    whenEndCounts(record, this.pollMs, () => {
      if (this.host.stopping() || record.bound !== null) return
      if (record.terminal.pty !== shell || record.woken) return
      if (record.terminal.exit !== null || record.terminal.exiting) return
      record.summary = { ...record.summary, lastProgram: null }
      record.changed = true
    })
  }

  /** Stops sampling, as the runner shuts down. */
  stop(): void {
    clearInterval(this.sampler)
    this.sampler = undefined
  }

  /** Each sample asks node-pty, and on Linux reads a small /proc file, per running terminal. */
  private sample(): void {
    let running = false
    for (const record of this.host.records()) {
      // A hibernating agent's shell is ending on purpose: what it leaves is no program to resume.
      if (record.hibernating || record.terminal.exit !== null || record.terminal.exiting) continue
      running = true
      record.foreground = sampleForeground(record.terminal.pty, record.foreground)
      const current = record.foreground.process
      const same = sameProcess(current, record.summary.process)
      // The program a fresh shell resumes, should this one be lost. A sample names it even
      // when the process is the summary's starting value (a plain shell on macOS), so an agent
      // that bound and left before the first sample doesn't stay the program a restart resumes.
      const lastProgram = record.woken
        ? record.summary.lastProgram
        : ((current && sampledProgram(current, record)) ?? record.summary.lastProgram)
      // Unchanged only if the program is too: a binding after the process was first sampled names a node one.
      if (same && lastProgram === record.summary.lastProgram) continue
      record.summary = { ...record.summary, process: current, lastProgram }
      record.changed = true
      this.host.sampled(record)
    }
    if (running) return
    this.stop()
  }
}
