import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"
import { afterEach, onTestFinished, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import { Claims } from "./resumes.js"
import { wakeMs } from "./resumes.js"
import type { ListedTerminal } from "./saved-terminals.js"
import { graceMs, keysHeldMs, Sleepers, type SleepersHost } from "./sleepers.js"

const row = (id: string, program: string | null, agents: ListedTerminal["agents"]) =>
  ({
    id,
    sessionId: "s",
    handle: id,
    naming: { person: null, opener: null, murmur: null, own: null, summary: null },
    openedBy: null,
    ledBy: null,
    command: null,
    lastProgram: program,
    work: null,
    cwd: "/tmp",
    agents,
    promptedAt: null,
    savedAt: 0,
  }) satisfies ListedTerminal

const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), "novadeck-sleepers-"))
  onTestFinished(() => rmSync(path, { recursive: true, force: true }))
  return path
}

type Calls = string[]

const setup = (
  rows: ListedTerminal[],
  options: { wanted?: Set<string>; connected?: boolean; done?: boolean } = {},
) => {
  const calls: Calls = []
  const resting = new Map<string, { agent: AgentName; sessionId: string }>()
  const held = new Set<string>()
  const wanted = options.wanted ?? new Set<string>()
  const host = {
    messaging: () => ({
      rest: (id: string, _scope: unknown, _handle: string, _led: unknown, on: never) => {
        resting.set(id, on)
        calls.push(`rest ${id}`)
      },
      resting: (id: string) => resting.get(id),
      wakesWanted: () => wanted,
      wakeWanted: (id: string) => wanted.has(id),
      wakeFailed: (id: string, why: string) => calls.push(`failed ${id}: ${why}`),
      wakeEnded: (id: string, why: string) => calls.push(`ended ${id}: ${why}`),
      shownAgent: () => undefined,
      unregister: (id: string, _good: boolean, why?: string) => {
        calls.push(`unregister ${id}: ${why}`)
        resting.delete(id)
      },
      deliveredAt: () => {
        calls.push("deliveries")
        return new Map<string, number>()
      },
    }),
    saves: () => ({ terminals: () => rows }),
    inbox: () => ({
      reports: () => ({ tell: null, done: options.done ? { subject: "x", at: 5 } : null }),
    }),
    claims: () => new Claims({ boundElsewhere: () => false }),
    connected: () => Promise.resolve(options.connected ?? true),
    resumes: () => true,
    projectOf: () => "p",
    held: (id: string) => held.has(id),
    closed: () => false,
    record: () => undefined,
    stopping: () => false,
    create: (each: ListedTerminal) => {
      calls.push(`create ${each.id}`)
      return Promise.resolve()
    },
    changed: (each: ListedTerminal) => calls.push(`changed ${each.id}`),
    ended: (id: string) => calls.push(`ended stream ${id}`),
  } as unknown as SleepersHost
  return { sleepers: new Sleepers(host), calls, resting, held }
}

describe("sleepers", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("rests a row whose last program is an agent with a session, and no other", () => {
    const { sleepers, resting } = setup([
      row("a", "claude", { claude: { sessionId: "one", seq: 1 } }),
      row("b", "bash", { claude: { sessionId: "two", seq: 1 } }),
      row("c", "claude", {}),
      row("d", "codex", { codex: { sessionId: "bad id!", seq: 1 } }),
    ])
    sleepers.start()
    expect([...resting.keys()]).toEqual(["a"])
  })

  it("rests Codex saved as node, but not node with several agents to choose from", () => {
    const { sleepers, resting } = setup([
      row("a", "node", { codex: { sessionId: "one", seq: 1 } }),
      row("b", "node", { codex: { sessionId: "two", seq: 1 }, claude: { sessionId: "x", seq: 2 } }),
    ])
    sleepers.start()
    expect(resting.get("a")).toEqual({ agent: "codex", sessionId: "one" })
    expect(resting.has("b")).toBe(false)
  })

  it("wakes a turn the stop cut short, once its claim is judged", async () => {
    const { sleepers } = setup([
      row("a", "claude", { claude: { sessionId: "one", seq: 1, turn: "running" } }),
    ])
    sleepers.start()
    expect(sleepers.asleep("a")).toBe(true)
    await vi.waitFor(() => expect(sleepers.asleep("a")).toBe(false))
  })

  it("leaves a wake that can't resume asleep and fails the messages that asked for it", async () => {
    const { sleepers, calls } = setup(
      [row("a", "claude", { claude: { sessionId: "one", seq: 1 } })],
      { wanted: new Set(["a"]), connected: false },
    )
    sleepers.start()
    await vi.waitFor(() => expect(calls.some((call) => call.startsWith("failed a"))).toBe(true))
    expect(sleepers.asleep("a")).toBe(true)
  })

  const waking = () =>
    setup([row("a", "claude", { claude: { sessionId: "one", seq: 1, turn: "waking" } })])

  it("creates the terminal itself after a grace, whether or not a client watches", async () => {
    vi.useFakeTimers()
    const { sleepers, calls } = waking()
    sleepers.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).not.toContain("create a")
    await vi.advanceTimersByTimeAsync(graceMs)
    expect(calls).toContain("create a")
  })

  it("creates a terminal a client first listed as waking, which only the runner now starts", async () => {
    vi.useFakeTimers()
    const { sleepers, calls } = waking()
    sleepers.start()
    await vi.advanceTimersByTimeAsync(10)
    // A client lists it now: waking, with the agent to resume.
    expect(sleepers.summaryOf(row("a", "claude", {}))).toMatchObject({
      sleeping: false,
      started: false,
      restingAgent: "claude",
    })
    await vi.advanceTimersByTimeAsync(graceMs)
    expect(calls.filter((call) => call === "create a")).toHaveLength(1)
  })

  it("starts no second create while one is under way, and again only if the wake still stands", async () => {
    vi.useFakeTimers()
    const { sleepers, calls } = waking()
    sleepers.start()
    await vi.advanceTimersByTimeAsync(10)
    const done = sleepers.creates("a")
    await vi.advanceTimersByTimeAsync(graceMs * 3)
    expect(calls).not.toContain("create a")
    done()
    await vi.advanceTimersByTimeAsync(graceMs)
    expect(calls.filter((call) => call === "create a")).toHaveLength(1)
  })

  it("makes no create of its own once a client's has started the shell", async () => {
    vi.useFakeTimers()
    const { sleepers, calls, resting } = waking()
    sleepers.start()
    await vi.advanceTimersByTimeAsync(10)
    const done = sleepers.creates("a")
    sleepers.started({ summary: { id: "a" } } as unknown as Record, "claude", "x")
    done()
    resting.delete("a")
    await vi.advanceTimersByTimeAsync(graceMs * 3)
    expect(calls).not.toContain("create a")
  })

  it("says why a wake can't happen, and that it is waking when it can", async () => {
    const refused = setup([row("a", "claude", { claude: { sessionId: "one", seq: 1 } })], {
      connected: false,
    })
    refused.sleepers.start()
    await expect(refused.sleepers.verdict("a")).resolves.toEqual({
      why: expect.stringContaining("isn't connected"),
    })
    const fine = setup([row("a", "claude", { claude: { sessionId: "one", seq: 1 } })])
    fine.sleepers.start()
    await expect(fine.sleepers.verdict("a")).resolves.toEqual({ waking: true })
    await expect(fine.sleepers.verdict("none")).resolves.toBeUndefined()
  })

  it("reads the deliveries once for every sleeper with a done mark in a listing", () => {
    const rows = [
      row("a", "claude", { claude: { sessionId: "one", seq: 1 } }),
      row("b", "claude", { claude: { sessionId: "two", seq: 1 } }),
    ]
    const { sleepers, calls } = setup(rows, { done: true })
    sleepers.start()
    const delivered = sleepers.deliveries()
    for (const each of rows) sleepers.summaryOf(each, delivered)
    expect(calls.filter((call) => call === "deliveries")).toHaveLength(1)
  })

  it("ends the message streams and says why when the integration fails", () => {
    const { sleepers, calls } = setup([
      row("a", "claude", { claude: { sessionId: "one", seq: 1 } }),
    ])
    sleepers.start()
    sleepers.integrationFailed()
    expect(calls).toContain("ended stream a")
    expect(calls.find((call) => call.startsWith("unregister a"))).toMatch(/integration/)
  })

  it("ends the message streams and says why when its agent is disconnected", () => {
    const { sleepers, calls } = setup([
      row("a", "claude", { claude: { sessionId: "one", seq: 1 } }),
    ])
    sleepers.start()
    sleepers.forgetAgent("claude", () => {})
    expect(calls).toContain("ended stream a")
    expect(calls.find((call) => call.startsWith("unregister a"))).toMatch(/disconnected/)
  })

  it("ends the wake of a started terminal whose agent never shows, after the wait", () => {
    vi.useFakeTimers()
    const { sleepers, calls, resting, held } = setup([], { wanted: new Set(["a"]) })
    resting.set("a", { agent: "claude", sessionId: "one" })
    held.add("a")
    const record = { summary: { id: "a" } } as unknown as Record
    // The record is the runner's meanwhile.
    ;(sleepers as unknown as { host: { record: () => Record } }).host.record = () => record
    sleepers.started(record, "claude", "x")
    expect(record.woken).toBeDefined()
    vi.advanceTimersByTime(wakeMs + 1)
    expect(calls.some((call) => call.startsWith("ended a:"))).toBe(true)
  })

  it("ends a plain shell's wake at once, and keeps the row as woken", () => {
    const { sleepers, calls, resting } = setup([])
    resting.set("a", { agent: "claude", sessionId: "one" })
    const record = { summary: { id: "a" } } as unknown as Record
    sleepers.started(record, undefined, "no resume")
    expect(calls).toContain("ended a: no resume")
    expect(record.woken).toBeDefined()
  })

  it("drops the person's keys while the woken shell has not read its resume command", () => {
    const { sleepers } = setup([])
    const file = join(folder(), "resume")
    writeFileSync(file, "claude --resume one")
    const record = { woken: Date.now(), resumeFile: file, resumeClaim: undefined }
    expect(sleepers.holdsKeys(record)).toBe(true)
    // Taken by the shell.
    rmSync(file)
    expect(sleepers.holdsKeys(record)).toBe(false)
  })

  it("lets keys through after the bound, and for a terminal no wake started", () => {
    const { sleepers } = setup([])
    const file = join(folder(), "resume")
    writeFileSync(file, "claude --resume one")
    expect(sleepers.holdsKeys({ woken: Date.now() - keysHeldMs - 1, resumeFile: file })).toBe(false)
    expect(sleepers.holdsKeys({ woken: undefined, resumeFile: file })).toBe(false)
  })

  it("holds keys for the window where the resume went as an argument, as on Windows cmd", () => {
    const { sleepers } = setup([])
    const claim = "claude:one"
    expect(
      sleepers.holdsKeys({ woken: Date.now(), resumeFile: undefined, resumeClaim: claim }),
    ).toBe(true)
    expect(
      sleepers.holdsKeys({
        woken: Date.now() - keysHeldMs - 1,
        resumeFile: undefined,
        resumeClaim: claim,
      }),
    ).toBe(false)
    // A plain shell resumed nothing.
    expect(sleepers.holdsKeys({ woken: Date.now(), resumeFile: undefined })).toBe(false)
  })
})
