import { afterEach, beforeEach, onTestFinished, vi } from "vitest"

const fresh = vi.hoisted(() => ({ group: undefined as number | undefined }))
vi.mock("@novadeck/terminal/pty", async (original) => ({
  ...(await original<typeof import("@novadeck/terminal/pty")>()),
  terminalForeground: async () => fresh.group,
}))

import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import {
  boundProgram,
  exitKeysMs,
  programOf,
  Sampler,
  shellBusy,
  endingSamples,
  graceSamples,
  type SampledRecord,
} from "./sampling.js"

const pollMs = 1_000
const platform = Object.getOwnPropertyDescriptor(process, "platform")!

const on = (name: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: name })
}

// A running terminal's record, as sampling reads it.
const running = (lastProgram: string | null, endKeyAt?: number): SampledRecord => {
  const pty = { pid: 1 }
  return {
    ...(endKeyAt !== undefined && { endKeyAt }),
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

  it("is let go a sample's time after the person's Ctrl+C or Ctrl+D", () => {
    on("win32")
    const record = running("claude", Date.now() - 1_000)
    sampler().prompted(record)
    vi.advanceTimersByTime(pollMs - 1)
    expect(record.summary.lastProgram).toBe("claude")
    vi.advanceTimersByTime(1)
    expect(record.summary.lastProgram).toBeNull()
    expect(record.changed).toBe(true)
  })

  it("is let go after the grace when no such key came just before, as a crash or a slow /exit ends it", () => {
    on("win32")
    const idle = running("claude")
    const earlier = running("claude", Date.now() - exitKeysMs - 1)
    for (const record of [idle, earlier]) sampler().prompted(record)
    vi.advanceTimersByTime(graceSamples * pollMs - 1)
    for (const record of [idle, earlier]) expect(record.summary.lastProgram).toBe("claude")
    vi.advanceTimersByTime(1)
    for (const record of [idle, earlier]) {
      expect(record.summary.lastProgram).toBeNull()
      expect(record.changed).toBe(true)
    }
  })

  it("stays the agent's when the runner stops right after its shell's prompt, as Windows shuts down", () => {
    on("win32")
    const record = running("claude")
    let stopping = false
    sampler(() => stopping).prompted(record)
    stopping = true
    vi.advanceTimersByTime(graceSamples * pollMs)
    expect(record.summary.lastProgram).toBe("claude")
    expect(record.changed).toBe(false)
  })

  it("waits out the system's word that the session is ending, then lets go", () => {
    on("win32")
    const before = running("claude")
    before.ending = Date.now()
    sampler().prompted(before)
    const during = running("claude")
    sampler().prompted(during)
    during.ending = Date.now()
    vi.advanceTimersByTime(endingSamples * pollMs - 1)
    for (const record of [before, during]) expect(record.summary.lastProgram).toBe("claude")
    vi.advanceTimersByTime(1 + pollMs)
    for (const record of [before, during]) expect(record.summary.lastProgram).toBeNull()
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

describe("whether a shell may be running a program", () => {
  const shell = (fields: object = {}) =>
    ({
      foreground: undefined,
      terminal: { pty: { pid: undefined } },
      summary: { process: { name: "bash", argv: null } },
      shellName: "bash",
      prompts: [{}],
      submitted: false,
      ...fields,
    }) as unknown as Parameters<typeof shellBusy>[0]

  it("reads the foreground anew, so a program that has ended since the last sample is idle", async () => {
    fresh.group = 7
    onTestFinished(() => void (fresh.group = undefined))
    const record = shell({
      foreground: { group: 999 },
      terminal: { pty: { pid: 7 } },
      summary: { process: { name: "ssh", argv: null } },
    })
    expect(await shellBusy(record)).toBe(false)
    fresh.group = 999
    expect(await shellBusy(record)).toBe(true)
  })

  it("is idle at its prompt", async () => {
    expect(await shellBusy(shell())).toBe(false)
  })

  it("is busy while another program holds the foreground", async () => {
    expect(await shellBusy(shell({ summary: { process: { name: "ssh", argv: null } } }))).toBe(true)
  })

  it("is busy after a line entered whose prompt hasn't come back, where the integration reports prompts", async () => {
    expect(await shellBusy(shell({ submitted: true }))).toBe(true)
  })

  it("ignores a line entered where the integration never reported a prompt", async () => {
    expect(await shellBusy(shell({ submitted: true, prompts: [] }))).toBe(false)
  })
})

describe("the program a foreground process is", () => {
  it("is its name, and for node the agent whose script it runs", () => {
    expect(programOf({ name: "claude", argv: null })).toBe("claude")
    expect(programOf({ name: "bash", argv: ["bash"] })).toBe("bash")
    expect(
      programOf({
        name: "node",
        argv: ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"],
      }),
    ).toBe("codex")
    expect(programOf({ name: "node", argv: ["node", "/home/me/.local/bin/codex"] })).toBe("codex")
    expect(programOf({ name: "node", argv: ["node", "server.js"] })).toBe("node")
    expect(programOf({ name: "node", argv: null })).toBe("node")
  })
})
