import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { agentProcess, apartOf, savingMs } from "./ending.js"

const bound = (instance: string | null) =>
  ({ bound: { binding: { instance } } }) as Parameters<typeof agentProcess>[0]

describe("the agent a terminal's end follows", () => {
  it("is the bound agent's process, as its hooks told it", () => {
    expect(agentProcess(bound("4242"))).toBe(4242)
  })

  it("is none with no agent bound, no record, or no pid told", () => {
    expect(agentProcess({ bound: null })).toBeUndefined()
    expect(agentProcess(undefined)).toBeUndefined()
    expect(agentProcess(bound(null))).toBeUndefined()
  })

  it("is none for what can't be a process of its own", () => {
    for (const instance of ["", "abc", "1", "0", "-5", "1.5"])
      expect(agentProcess(bound(instance))).toBeUndefined()
  })
})

describe("what a terminal's harnesses run apart from it", () => {
  // A Claude Code configuration folder whose background service's lock names pid 4242.
  const claudeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "ending-apart-"))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, "projects", "p"), { recursive: true })
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 4242, procStart: "777" }))
    return { transcript: join(home, "projects", "p", "s1.jsonl") }
  }

  it("is the bound session's harness's, found by its transcript", async () => {
    const { transcript } = claudeHome()
    const record = {
      bound: { binding: { agent: "claude", sessionId: "s1", instance: "41" } },
      agents: { claude: { sessionId: "s1", seq: 1, transcript } },
    } as unknown as Parameters<typeof apartOf>[0]
    expect(await apartOf(record)).toEqual([{ pid: 4242, start: "777" }])
  })

  it("is each harness's latest session's once its agent has left, as its service still runs", async () => {
    const { transcript } = claudeHome()
    const record = {
      bound: null,
      agents: {
        claude: { sessionId: "s1", seq: 1, transcript },
        codex: { sessionId: "c1", seq: 2 },
      },
    } as unknown as Parameters<typeof apartOf>[0]
    expect(await apartOf(record)).toEqual([{ pid: 4242, start: "777" }])
  })

  it("is nothing with no record or no session", async () => {
    expect(await apartOf(undefined)).toEqual([])
    expect(await apartOf({ bound: null, agents: {} })).toEqual([])
  })
})

describe("how long an agent is left running before its end", () => {
  const at = (agent: string, state: "idle" | "working", ended: number | null) =>
    ({
      bound: {
        binding: { agent },
        activity: { state, lastTurn: ended === null ? null : { at: ended } },
      },
    }) as unknown as Parameters<typeof savingMs>[0]

  it("is what Antigravity has left of the 2 s it needs after its latest turn's end", () => {
    expect(savingMs(at("agy", "idle", 10_000), 10_000)).toBe(2_000)
    expect(savingMs(at("agy", "idle", 10_000), 10_200)).toBe(1_800)
  })

  it("is none once it has had it, while it works, before any turn ended, for another harness, and with none bound", () => {
    expect(savingMs(at("agy", "idle", 10_000), 20_000)).toBe(0)
    expect(savingMs(at("agy", "working", 10_000), 10_000)).toBe(0)
    expect(savingMs(at("agy", "idle", null), 10_000)).toBe(0)
    expect(savingMs(at("claude", "idle", 10_000), 10_000)).toBe(0)
    expect(savingMs({ bound: null })).toBe(0)
    expect(savingMs(undefined)).toBe(0)
  })
})
