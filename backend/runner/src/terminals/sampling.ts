import { basename } from "node:path"

import type { ForegroundProcess } from "@novadeck/protocol"
import { sampleForeground } from "@novadeck/terminal/pty"

import type { Record } from "./record.js"

/** What sampling reads of a terminal's record, and what it keeps there. */
export type SampledRecord = Pick<Record, "terminal" | "foreground" | "summary" | "changed">

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
    if (this.sampler || this.host.stopping() || process.platform === "win32") return
    this.sampler = setInterval(() => this.sample(), this.pollMs)
    this.sampler.unref()
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
