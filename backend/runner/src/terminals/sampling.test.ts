import { afterEach, beforeEach, onTestFinished, vi } from "vitest"

const fresh = vi.hoisted(() => ({
  group: undefined as number | undefined,
  sampled: undefined as { process: { name: string; argv: string[] | null } | null } | undefined,
  table: undefined as import("@novadeck/terminal/pty").TableRow[] | undefined,
  listing: undefined as import("@novadeck/terminal/pty").Listed[] | undefined,
  jobs: false as boolean | undefined,
  childCalls: 0,
  tableCalls: 0,
  listings: [] as (number | undefined)[],
}))
vi.mock("@novadeck/terminal/pty", async (original) => {
  const real = await original<typeof import("@novadeck/terminal/pty")>()
  return {
    ...real,
    terminalForeground: async () => fresh.group,
    processTable: async () => {
      fresh.tableCalls += 1
      return fresh.table
    },
    processListing: (_platform?: unknown, _shared?: unknown, limitMs?: number) => {
      fresh.listings.push(limitMs)
      return async () => fresh.listing
    },
    hasChildProcess: async () => {
      fresh.childCalls += 1
      return fresh.jobs
    },
    sampleForeground: ((...args: Parameters<typeof real.sampleForeground>) =>
      fresh.sampled ?? real.sampleForeground(...args)) as typeof real.sampleForeground,
  }
})

import type { Member } from "@novadeck/terminal/pty"

import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import {
  boundProgram,
  busyTerminals,
  exitKeysMs,
  programOf,
  programRuns,
  Sampler,
  shared,
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

describe("which terminals hold work a close would end", () => {
  type Table = NonNullable<typeof fresh.table>
  const row = (pid: number, ppid: number, tpgid: number, tty = "pts/1", comm = "sh") => ({
    pid,
    ppid,
    pgid: pid,
    tpgid,
    tty,
    comm,
  })
  const shell = (id: string, pid: number, fields: { [key: string]: unknown } = {}) =>
    ({
      foreground: undefined,
      terminal: { pty: { pid }, exit: null, exiting: false },
      summary: {
        id,
        agent: null,
        ready: null,
        startup: null,
        process: { name: "bash", argv: null },
      },
      bound: null,
      shellName: "bash",
      prompts: [{}],
      submitted: false,
      ...fields,
    }) as unknown as Parameters<typeof busyTerminals>[0] extends Iterable<infer R> ? R : never
  const withAgent = (id: string, pid: number, fields: { [key: string]: unknown } = {}) =>
    shell(id, pid, {
      summary: { id, agent: "claude", ready: null, startup: null },
      bound: { binding: { agent: "claude", sessionId: "s", instance: null } },
      ...fields,
    })
  const set = (table: Table | undefined) => {
    fresh.table = table
    onTestFinished(() => void (fresh.table = undefined))
  }

  it("names the shells with a program, a job or a line entered, and leaves an idle one out", async () => {
    set([
      row(100, 1, 100),
      row(101, 1, 555),
      row(102, 1, 102),
      row(120, 102, 102),
      row(103, 1, 103),
    ])
    const records = [
      shell("at-prompt", 100),
      shell("program", 101),
      shell("job", 102),
      shell("typed", 103, { submitted: true }),
    ]
    expect(await busyTerminals(records)).toEqual({
      busy: ["program", "job", "typed"],
      unknown: [],
    })
  })

  it("names a suspended program, which the shell's prompt has taken the terminal back from", async () => {
    set([row(100, 1, 100), row(130, 100, 100)])
    expect(await busyTerminals([shell("stopped", 100)])).toEqual({ busy: ["stopped"], unknown: [] })
  })

  it("leaves an agent's own process out, and names a job of its shell's beside it", async () => {
    // The agent leads the foreground group, 300; a job the shell started is another child.
    set([
      row(200, 1, 300),
      row(300, 200, 300),
      row(210, 1, 310),
      row(310, 210, 310),
      row(311, 210, 210),
    ])
    expect(await busyTerminals([withAgent("alone", 200), withAgent("beside", 210)])).toEqual({
      busy: ["beside"],
      unknown: [],
    })
  })

  it("names a suspended agent, once the shell holds the terminal again", async () => {
    set([row(200, 1, 200), row(300, 200, 200)])
    expect(await busyTerminals([withAgent("suspended", 200)])).toEqual({
      busy: ["suspended"],
      unknown: [],
    })
  })

  it("holds an agent expected or ready to the same, whichever harness", async () => {
    set([
      row(200, 1, 300),
      row(300, 200, 300),
      row(201, 1, 301),
      row(301, 201, 301),
      row(302, 201, 201),
    ])
    const ready = (id: string, pid: number, agent: string) =>
      shell(id, pid, { summary: { id, agent: null, ready: agent, startup: null } })
    expect(await busyTerminals([ready("codex", 200, "codex"), ready("agy", 201, "agy")])).toEqual({
      busy: ["agy"],
      unknown: [],
    })
  })

  it("calls every shell unknown where the process list can't be read, never idle", async () => {
    set(undefined)
    expect(await busyTerminals([shell("a", 100), withAgent("b", 200)])).toEqual({
      busy: [],
      unknown: ["a", "b"],
    })
  })

  it("calls a shell unknown that the list doesn't hold, and leaves out ended and unstarted ones", async () => {
    set([row(100, 1, 100)])
    const records = [
      shell("gone", 999),
      shell("ended", 100, { terminal: { pty: { pid: 100 }, exit: { code: 0 }, exiting: false } }),
      shell("unstarted", 0, { terminal: { pty: { pid: undefined }, exit: null, exiting: false } }),
    ]
    expect(await busyTerminals(records)).toEqual({ busy: [], unknown: ["gone"] })
  })

  it("calls an agent's shell unknown when the list lacks it or names no foreground group", async () => {
    set([row(200, 1, -1)])
    expect(await busyTerminals([withAgent("nogroup", 200), withAgent("missing", 999)])).toEqual({
      busy: [],
      unknown: ["nogroup", "missing"],
    })
  })

  describe("an agent bound under its shell, by hibernation's rule", () => {
    type Listed = NonNullable<typeof fresh.listing>[number]
    const proc = (pid: number, parent: number, group: number, foreground = 0): Listed => ({
      pid,
      parent,
      group,
      foreground,
      started: `s${pid}`,
      zombie: false,
    })
    // The shell 200 holds its terminal for the agent 300 and what it started: a server 350
    // the agent came up with, which the baseline holds.
    const base = [proc(200, 1, 200, 300), proc(300, 200, 300, 300), proc(350, 300, 350)]
    // The table the same shell shows: the agent is its child, in the foreground.
    const table = [row(200, 1, 300), row(300, 200, 300)]
    const listed = (...more: Listed[]) => {
      fresh.listing = [...base, ...more]
      fresh.table = table
      onTestFinished(() => {
        fresh.listing = undefined
        fresh.table = undefined
      })
    }
    const boundTo = (id: string, agent: string, taken: string[] | null = ["350:s350"]) =>
      shell(id, 200, {
        summary: { id, agent, ready: null, startup: null },
        bound: { binding: { agent, sessionId: "s", instance: "300" } },
        baseline: { instance: "300", taken: taken ? new Set(taken) : undefined, begun: true },
      })

    it("is idle with only what it came up with, whichever harness", async () => {
      listed()
      for (const agent of ["claude", "codex", "agy"])
        // eslint-disable-next-line no-await-in-loop -- Each harness is read alone.
        expect(await busyTerminals([boundTo(agent, agent)])).toEqual({ busy: [], unknown: [] })
    })

    it("reads the system a fixed number of times however many agents, and waits as long as the table may", async () => {
      // The shells of three agents of one terminal's kind each, all under the same listing.
      listed()
      fresh.childCalls = 0
      fresh.tableCalls = 0
      fresh.listings = []
      const records = ["claude", "codex", "agy"].flatMap((agent) => [
        boundTo(agent, agent),
        boundTo(`${agent}2`, agent),
      ])
      await busyTerminals(records)
      expect(fresh.tableCalls).toBe(1)
      expect(fresh.listings).toEqual([2_000])
      expect(fresh.childCalls).toBe(0)
    })

    it("is unknown for a bound agent where the table can't be read", async () => {
      listed()
      fresh.table = undefined
      expect(await busyTerminals([boundTo("blind", "claude")])).toEqual({
        busy: [],
        unknown: ["blind"],
      })
    })

    it("is busy for a process that came after, as Codex's background terminal, whichever harness", async () => {
      // A dev server its exec_command or Bash tool left running, under the agent.
      listed(proc(400, 300, 400), proc(410, 400, 400))
      for (const agent of ["claude", "codex", "agy"])
        // eslint-disable-next-line no-await-in-loop -- Each harness is read alone.
        expect(await busyTerminals([boundTo(agent, agent)])).toEqual({ busy: [agent], unknown: [] })
    })

    it("is busy for a job of the shell's beside it, and for an agent suspended", async () => {
      listed()
      // `pnpm dev &` typed before the agent: another child of the shell, on its terminal.
      fresh.table = [...table, row(310, 200, 310)]
      expect(await busyTerminals([boundTo("beside", "codex")])).toEqual({
        busy: ["beside"],
        unknown: [],
      })
      fresh.table = table
      // The shell holds the terminal again.
      fresh.listing = [proc(200, 1, 200, 200), proc(300, 200, 300, 200), proc(350, 300, 350)]
      expect(await busyTerminals([boundTo("stopped", "claude")])).toEqual({
        busy: ["stopped"],
        unknown: [],
      })
    })

    it("is unknown where the processes it came up with weren't recorded, the agent isn't found or the list can't be read", async () => {
      listed(proc(400, 300, 400))
      expect(await busyTerminals([boundTo("early", "codex", null)])).toEqual({
        busy: [],
        unknown: ["early"],
      })
      fresh.listing = [proc(200, 1, 200, 200)]
      expect(await busyTerminals([boundTo("lost", "claude")])).toEqual({
        busy: [],
        unknown: ["lost"],
      })
      fresh.listing = undefined
      expect(await busyTerminals([boundTo("blind", "agy")])).toEqual({
        busy: [],
        unknown: ["blind"],
      })
    })
  })

  describe("on Windows, where an agent not yet bound has no process to leave out", () => {
    const member = (pid: number, name: string, parent?: number): Member => ({
      pid,
      startedAt: pid,
      name,
      ...(parent === undefined ? {} : { parent }),
    })
    const trees = (members: Member[] | undefined) => ({ read: async () => members })
    const unbound = (id: string, agent: string) =>
      shell(id, 10, { summary: { id, agent: null, ready: agent, startup: null } })

    it("leaves a harness's own program and what it runs out, whichever harness, and names a job", async () => {
      on("win32")
      for (const agent of ["claude", "codex", "agy"]) {
        const quiet = trees([
          member(10, "cmd.exe"),
          member(11, `${agent}.exe`, 10),
          member(12, "node.exe", 11),
        ])
        // eslint-disable-next-line no-await-in-loop -- Each harness is read alone.
        expect(await busyTerminals([unbound(agent, agent)], quiet)).toEqual({
          busy: [],
          unknown: [],
        })
        // `start /b npm run dev` before it: another child of the shell.
        const job = trees([
          member(10, "cmd.exe"),
          member(11, `${agent}.exe`, 10),
          member(13, "node.exe", 10),
        ])
        // eslint-disable-next-line no-await-in-loop -- Each harness is read alone.
        expect(await busyTerminals([unbound(agent, agent)], job)).toEqual({
          busy: [agent],
          unknown: [],
        })
      }
    })

    it("is unknown where the tree can't be read", async () => {
      on("win32")
      expect(await busyTerminals([unbound("codex", "codex")], trees(undefined))).toEqual({
        busy: [],
        unknown: ["codex"],
      })
    })
  })

  it("lets overlapping asks share one read, and reads again for a later one", async () => {
    let reads = 0
    const { read } = shared(async () => {
      reads += 1
      await Promise.resolve()
      return reads
    })
    expect(await Promise.all([read(), read()])).toEqual([1, 1])
    expect(await read()).toBe(2)
  })

  it("gives a fresh ask a read that starts after it, which later fresh asks share", async () => {
    // What the system holds when a read starts, as a program started during the read before.
    let programs = 0
    let started = 0
    const { read, fresh: again } = shared(async () => {
      started += 1
      const seen = programs
      await new Promise((resolve) => setTimeout(resolve, 5))
      return seen
    })
    const inFlight = read()
    programs = 1
    const later = [again(), again()]
    await vi.advanceTimersByTimeAsync(20)
    expect(await inFlight).toBe(0)
    expect(await Promise.all(later)).toEqual([1, 1])
    expect(started).toBe(2)
    // With none in flight it starts at once.
    const now = again()
    await vi.advanceTimersByTimeAsync(20)
    expect(await now).toBe(1)
  })
})
