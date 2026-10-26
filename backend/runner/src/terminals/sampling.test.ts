import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import { boundProgram, Sampler, type SampledRecord } from "./sampling.js"

const pollMs = 1_000
const platform = Object.getOwnPropertyDescriptor(process, "platform")!

const on = (name: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: name })
}

// A running terminal's record, as sampling reads it.
const running = (lastProgram: string | null): SampledRecord => {
  const pty = { pid: 1 }
  return {
    summary: { lastProgram } as SampledRecord["summary"],
    changed: false,
    bound: null,
    foreground: undefined,
    terminal: { pty, exit: null, exiting: false } as unknown as SampledRecord["terminal"],
  }
}

const bound = { binding: { agent: "claude", sessionId: "s", instance: null } } as Record["bound"]

const sampler = (stopping = () => false) =>
  new Sampler<SampledRecord>(pollMs, { stopping, records: () => [], sampled: () => {} })

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, "platform", platform)
})

describe("the program a fresh shell resumes where no sample names it", () => {
  it("is the agent a session of binds the terminal, on Windows", () => {
    on("win32")
    const record = running(null)
    expect(boundProgram(record, "codex")).toBe(true)
    expect(record.summary.lastProgram).toBe("codex")
    expect(record.changed).toBe(true)
    record.changed = false
    expect(boundProgram(record, "codex")).toBe(false)
    expect(record.changed).toBe(false)
  })

  it("is left to the sampler where the platform names the foreground", () => {
    on("linux")
    const record = running(null)
    expect(boundProgram(record, "claude")).toBe(false)
    expect(record.summary.lastProgram).toBeNull()
  })

  it("is let go once the shell has held its prompt for a sample's time", () => {
    on("win32")
    const record = running("claude")
    sampler().prompted(record)
    vi.advanceTimersByTime(pollMs - 1)
    expect(record.summary.lastProgram).toBe("claude")
    vi.advanceTimersByTime(1)
    expect(record.summary.lastProgram).toBeNull()
    expect(record.changed).toBe(true)
  })

  it("stays the agent's when the runner stops right after its shell's prompt, as Windows shuts down", () => {
    on("win32")
    const record = running("claude")
    let stopping = false
    sampler(() => stopping).prompted(record)
    stopping = true
    vi.advanceTimersByTime(pollMs)
    expect(record.summary.lastProgram).toBe("claude")
    expect(record.changed).toBe(false)
  })

  it("stays the agent's when one binds again, or the shell ends or is replaced, meanwhile", () => {
    on("win32")
    const rebound = running("claude")
    const ended = running("claude")
    const replaced = running("claude")
    for (const record of [rebound, ended, replaced]) sampler().prompted(record)
    rebound.bound = bound
    ended.terminal = { ...ended.terminal, exiting: true } as SampledRecord["terminal"]
    replaced.terminal = { ...replaced.terminal, pty: { pid: 2 } } as SampledRecord["terminal"]
    vi.advanceTimersByTime(pollMs)
    for (const record of [rebound, ended, replaced])
      expect(record.summary.lastProgram).toBe("claude")
  })

  it("is the sampler's to let go where the platform names the foreground", () => {
    on("darwin")
    const record = running("claude")
    sampler().prompted(record)
    vi.advanceTimersByTime(pollMs)
    expect(record.summary.lastProgram).toBe("claude")
  })
})
