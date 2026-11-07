import { afterEach, beforeEach, onTestFinished, vi } from "vitest"

const fresh = vi.hoisted(() => ({
  group: undefined as number | undefined,
  sampled: undefined as { process: { name: string; argv: string[] | null } | null } | undefined,
}))
vi.mock("@novadeck/terminal/pty", async (original) => {
  const real = await original<typeof import("@novadeck/terminal/pty")>()
  return {
    ...real,
    terminalForeground: async () => fresh.group,
    sampleForeground: ((...args: Parameters<typeof real.sampleForeground>) =>
      fresh.sampled ?? real.sampleForeground(...args)) as typeof real.sampleForeground,
  }
})

import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import {
  boundProgram,
  exitKeysMs,
  programOf,
  programRuns,
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
    shellName: "bash",
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

  it("is left to the sampler once it has named a program, where the platform names the foreground", () => {
    on("linux")
    const record = running("bash")
    expect(boundProgram(record, "claude")).toBe(false)
    expect(record.summary.lastProgram).toBe("bash")
  })

  it("is the agent that binds before the first sample, as Antigravity does within a second of starting", () => {
    on("linux")
    const record = running(null)
    expect(boundProgram(record, "agy")).toBe(true)
    expect(record.summary.lastProgram).toBe("agy")
    expect(record.changed).toBe(true)
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

describe("a woken shell whose agent has not shown", () => {
  it("keeps the program it resumes when its prompt shows, on Windows", () => {
    on("win32")
    const record = { ...running("claude"), woken: Date.now() }
    sampler().prompted(record)
    vi.advanceTimersByTime(graceSamples * pollMs)
    expect(record.summary.lastProgram).toBe("claude")
    expect(record.changed).toBe(false)
  })

  it("keeps it when the wake came while the prompt's wait was running, on Windows", () => {
    on("win32")
    const record: SampledRecord = running("claude")
    sampler().prompted(record)
    record.woken = Date.now()
    vi.advanceTimersByTime(graceSamples * pollMs)
    expect(record.summary.lastProgram).toBe("claude")
  })

  it("lets it go once the person typed a line there, on Windows", () => {
    on("win32")
    const record: SampledRecord = { ...running("claude"), woken: Date.now() }
    record.woken = undefined
    sampler().prompted(record)
    vi.advanceTimersByTime(graceSamples * pollMs)
    expect(record.summary.lastProgram).toBeNull()
  })

  it("keeps the program it resumes when a sample names the shell, where the platform names the foreground", () => {
    on("linux")
    fresh.sampled = { process: { name: "bash", argv: null } }
    onTestFinished(() => void (fresh.sampled = undefined))
    const shelled = (): SampledRecord => {
      const record = running("claude")
      record.summary = { ...record.summary, process: null }
      return record
    }
    const woken = { ...shelled(), woken: Date.now() }
    const typed = shelled()
    const started = new Sampler<SampledRecord>(pollMs, {
      stopping: () => false,
      records: () => [woken, typed],
      sampled: () => {},
    })
    started.start()
    vi.advanceTimersByTime(pollMs)
    started.stop()
    expect(woken.summary).toMatchObject({ process: { name: "bash" }, lastProgram: "claude" })
    expect(typed.summary).toMatchObject({ process: { name: "bash" }, lastProgram: "bash" })
  })
})

describe("the first sample of a plain shell", () => {
  it("names the shell the program to resume even where it equals the summary's starting value, as on macOS", () => {
    on("darwin")
    // macOS reports a plain shell without its arguments, as the summary starts with it.
    fresh.sampled = { process: { name: "bash", argv: null } }
    onTestFinished(() => void (fresh.sampled = undefined))
    const record = running(null)
    record.summary = { ...record.summary, process: { name: "bash", argv: null } }
    // An agent bound before the first sample and left within it.
    expect(boundProgram(record, "claude")).toBe(true)
    expect(record.summary.lastProgram).toBe("claude")
    const started = new Sampler<SampledRecord>(pollMs, {
      stopping: () => false,
      records: () => [record],
      sampled: () => {},
    })
    started.start()
    vi.advanceTimersByTime(pollMs)
    started.stop()
    expect(record.summary.lastProgram).toBe("bash")
    expect(record.changed).toBe(true)
  })
})

describe("a node process sampled in a terminal", () => {
  const sampleNode = (bindingOf: Record["bound"], argv: string[] | null) => {
    on("darwin")
    fresh.sampled = { process: { name: "node", argv } }
    onTestFinished(() => void (fresh.sampled = undefined))
    const record = running(null)
    record.summary = { ...record.summary, process: null }
    record.bound = bindingOf
    const started = new Sampler<SampledRecord>(pollMs, {
      stopping: () => false,
      records: () => [record],
      sampled: () => {},
    })
    started.start()
    vi.advanceTimersByTime(pollMs)
    return { record, started }
  }

  const sampleAs = (name: string, bindingOf: Record["bound"]) => {
    on("darwin")
    fresh.sampled = { process: { name, argv: null } }
    onTestFinished(() => void (fresh.sampled = undefined))
    const record = running(null)
    record.summary = { ...record.summary, process: null }
    record.bound = bindingOf
    const started = new Sampler<SampledRecord>(pollMs, {
      stopping: () => false,
      records: () => [record],
      sampled: () => {},
    })
    started.start()
    vi.advanceTimersByTime(pollMs)
    return { record, started }
  }

  it("is the agent bound right now, though macOS names no script", () => {
    const { record, started } = sampleNode(bound, null)
    started.stop()
    expect(record.summary.lastProgram).toBe("claude")
  })

  it("takes the agent that binds after the process was first sampled", () => {
    const { record, started } = sampleNode(null, null)
    expect(record.summary.lastProgram).toBe("node")
    record.bound = bound
    vi.advanceTimersByTime(pollMs)
    started.stop()
    expect(record.summary.lastProgram).toBe("claude")
  })

  it("stays node with no agent bound, and by its script where argv tells it", () => {
    const first = sampleNode(null, null)
    first.started.stop()
    expect(first.record.summary.lastProgram).toBe("node")
    const second = sampleNode(null, ["node", "/home/me/.local/bin/codex"])
    second.started.stop()
    expect(second.record.summary.lastProgram).toBe("codex")
  })

  it("is the agent bound right now for any program macOS names by its file, but the shell", () => {
    for (const name of ["claude.exe", "2.1.319"]) {
      const { record, started } = sampleAs(name, bound)
      started.stop()
      expect(record.summary.lastProgram).toBe("claude")
    }
    const shell = sampleAs("-bash", bound)
    shell.started.stop()
    expect(shell.record.summary.lastProgram).toBe("-bash")
  })

  it("stays node where argv tells another script, though an agent is bound", () => {
    const { record, started } = sampleNode(bound, ["node", "server.js"])
    started.stop()
    expect(record.summary.lastProgram).toBe("node")
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
    expect(programOf({ name: "claude.exe", argv: null })).toBe("claude")
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

describe("whether a program runs in a shell, for the summary", () => {
  const shell = (fields: object = {}) =>
    ({
      foreground: undefined,
      terminal: { pty: { pid: undefined }, exit: null, exiting: false },
      summary: { process: { name: "bash", argv: null } },
      shellName: "bash",
      prompts: [],
      submitted: false,
      startupRuns: false,
      ...fields,
    }) as unknown as Parameters<typeof programRuns>[0]

  it("counts a startup command that has not ended, before any prompt was reported, as on Windows", () => {
    expect(programRuns(shell())).toBe(false)
    expect(programRuns(shell({ startupRuns: true }))).toBe(true)
  })

  it("stops counting it once the shell's prompt came back", () => {
    expect(programRuns(shell({ startupRuns: false, submitted: true }))).toBe(false)
  })
})
