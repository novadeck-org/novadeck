import { basename } from "node:path"

import type { AgentName, ForegroundProcess } from "@novadeck/protocol"
import { hasChildProcess, sampleForeground, terminalForeground } from "@novadeck/terminal/pty"

import type { Record } from "./record.js"

/** What sampling reads of a terminal's record, and what it keeps there. */
export type SampledRecord = Pick<
  Record,
  "terminal" | "foreground" | "summary" | "changed" | "bound"
>

// Whether the platform hides a terminal's foreground program, as Windows does: no sample
// names it there.
const foregroundHidden = (): boolean => process.platform === "win32"

/**
 * An agent's session bound the terminal. Where no sample names the foreground program,
 * the agent is the program a fresh shell resumes, should this one be lost; the sampler
 * says so elsewhere. Whether that changed it, which the caller saves.
 */
export const boundProgram = (
  record: Pick<Record, "summary" | "changed">,
  agent: AgentName,
): boolean => {
  if (!foregroundHidden() || record.summary.lastProgram === agent) return false
  record.summary = { ...record.summary, lastProgram: agent }
  record.changed = true
  return true
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
  record: Pick<
    Record,
    "foreground" | "terminal" | "summary" | "shellName" | "prompts" | "submitted"
  >,
  trees?: Parameters<typeof hasChildProcess>[1],
): Promise<boolean> => {
  // The foreground read now, where the platform tells it: the last sample may predate a
  // program that has ended since.
  const group = await terminalForeground(record.terminal.pty.pid)
  if (group !== undefined ? group !== record.terminal.pty.pid : !shellAtPrompt(record)) return true
  if (record.prompts.length > 0 && record.submitted) return true
  return (await hasChildProcess(record.terminal.pty.pid, trees)) === true
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
   * it too.
   */
  prompted(record: R): void {
    if (!foregroundHidden() || record.summary.lastProgram === null) return
    const shell = record.terminal.pty
    setTimeout(() => {
      if (this.host.stopping() || record.bound !== null || record.terminal.pty !== shell) return
      if (record.terminal.exit !== null || record.terminal.exiting) return
      record.summary = { ...record.summary, lastProgram: null }
      record.changed = true
    }, this.pollMs).unref()
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
      if (record.terminal.exit !== null || record.terminal.exiting) continue
      running = true
      record.foreground = sampleForeground(record.terminal.pty, record.foreground)
      const current = record.foreground.process
      if (sameProcess(current, record.summary.process)) continue
      // The program a fresh shell resumes, should this one be lost.
      const lastProgram = current?.name ?? record.summary.lastProgram
      record.summary = { ...record.summary, process: current, lastProgram }
      record.changed = true
      this.host.sampled(record)
    }
    if (running) return
    this.stop()
  }
}
