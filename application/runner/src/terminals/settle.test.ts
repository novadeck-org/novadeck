import { randomUUID } from "node:crypto"

import { hookShellSlackMs } from "@novadeck/harness-core/harness"
import { screen as screenWith } from "@novadeck/harness-core/testing/screens"
import { vi } from "vitest"

import { submitWindowMs } from "../messaging/delivery.js"
import { describe, expect, it } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"
import { Terminals } from "./manager.js"

// The manager's pause between looks at a screen runs on the clock the tests fake.
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: <T>(ms: number, value?: T) =>
    new Promise<T | undefined>((resolve) => globalThis.setTimeout(() => resolve(value), ms)),
}))

const cwd = process.cwd()
const fixture = (resources: Resources) => ({
  manager: (options: ConstructorParameters<typeof Terminals>[0] = {}) => {
    const instance = new Terminals({ shell: "/bin/sh", env: { PS1: "" }, ...options })
    resources.defer(() => instance.shutdown())
    return instance
  },
})

// A session of Antigravity's that binds a second past the window in which the person's last
// Enter could have submitted it, wider on Windows, where a hook's shell may start slowly.
const root = (sessionId: string) => ({
  type: "new",
  root: { agent: "agy", sessionId, instance: null, source: "binding" },
  guess: false,
  ready: true,
  startedAt: Date.now() + submitWindowMs + hookShellSlackMs(process.platform) + 1_000,
})

describe("settling a draft kept only by doubt", () => {
  type Inside = {
    records: Map<string, { binding: unknown }>
    screenOf: (id: string) => Promise<unknown>
    settleBox: (record: unknown) => void
    messaging: {
      rooted: (id: string, changes: readonly unknown[]) => void
      keys: (id: string, kinds: readonly string[], asked: boolean) => void
      delivery: (id: string) => { state: string; epoch: number; box: { doubted: boolean } }
    }
  }
  const rule = "─".repeat(60)
  // Antigravity's screen with its box empty, or holding what the person typed.
  const boxed = (text: string) =>
    screenWith({ rows: [rule, `> ${text}`, rule], cursor: { row: 1, column: 2 + text.length } })
  const empty = boxed("")
  const typed = boxed("hello")

  /**
   * A terminal whose Antigravity session bound too long after the person's Enter to tell it
   * ran their command, a /clear that took long: Drafting only by doubt. `reads` gives each
   * look at the screen, the last for the rest.
   */
  const doubting = async (terminals: ReturnType<typeof fixture>, reads: unknown[]) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    record.binding = { agent: "agy", sessionId: "s", instance: null }
    const { messaging } = inside
    messaging.rooted(terminal.id, [root("a")])
    messaging.keys(terminal.id, ["content", "enter"], false)
    messaging.rooted(terminal.id, [root("b")])
    expect(messaging.delivery(terminal.id)).toMatchObject({
      state: "drafting",
      box: { doubted: true },
    })
    let looked = 0
    inside.screenOf = () => Promise.resolve(reads[Math.min(looked++, reads.length - 1)])
    return {
      manager,
      inside,
      record,
      id: terminal.id,
      looks: () => looked,
      state: () => messaging.delivery(terminal.id)?.state,
    }
  }

  it("is Ready once the box reads empty twice running, and not after one empty read", async ({
    resources,
  }) => {
    const settled = await doubting(fixture(resources), [empty, empty])
    const between = await doubting(fixture(resources), [empty, typed, empty, typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      settled.inside.settleBox(settled.record)
      between.inside.settleBox(between.record)
      await vi.advanceTimersByTimeAsync(0)
      expect(settled.state()).toBe("drafting")
      await vi.advanceTimersByTimeAsync(100)
      expect(settled.state()).toBe("ready")
      // Another read, then not empty: the first of the two reads is forgotten.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(between.state()).toBe("drafting")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up after its window, leaving the draft", async ({ resources }) => {
    const drafted = await doubting(fixture(resources), [typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      drafted.inside.settleBox(drafted.record)
      await vi.advanceTimersByTimeAsync(5_200)
      const looked = drafted.looks()
      expect(looked).toBeGreaterThan(40)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(drafted.looks()).toBe(looked)
      expect(drafted.state()).toBe("drafting")
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops looking when the terminal ends", async ({ resources }) => {
    const reading = await doubting(fixture(resources), [typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      reading.inside.settleBox(reading.record)
      await vi.advanceTimersByTimeAsync(500)
      expect(reading.looks()).toBeGreaterThan(1)
      const closing = reading.manager.close({ terminalId: reading.id })
      await vi.advanceTimersByTimeAsync(1_000)
      await closing
      const closed = reading.looks()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reading.looks()).toBe(closed)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops looking at a key from the person, who leaves a draft", async ({ resources }) => {
    const reading = await doubting(fixture(resources), [typed, empty])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      reading.inside.settleBox(reading.record)
      await vi.advanceTimersByTimeAsync(0)
      reading.inside.messaging.keys(reading.id, ["content"], false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reading.looks()).toBeLessThanOrEqual(2)
      expect(reading.state()).toBe("drafting")
    } finally {
      vi.useRealTimers()
    }
  })

  it("polls a later doubt that began while it looked, once the first one is stale", async ({
    resources,
  }) => {
    const reading = await doubting(fixture(resources), [empty])
    const { messaging } = reading.inside
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // The second read is the one the next doubt begins during.
      const screens = [empty, empty]
      let release: (() => void) | undefined
      reading.inside.screenOf = async () => {
        const screen = screens.shift() ?? empty
        if (screens.length === 0 && release === undefined)
          await new Promise<void>((resolve) => (release = resolve))
        return screen
      }
      reading.inside.settleBox(reading.record)
      await vi.advanceTimersByTimeAsync(100)
      expect(release).toBeDefined()
      // The person typed, pressed Enter, and a /clear's session bound late again.
      messaging.keys(reading.id, ["content", "enter"], false)
      messaging.rooted(reading.id, [root("c")])
      expect(messaging.delivery(reading.id)).toMatchObject({ box: { doubted: true } })
      release!()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reading.state()).toBe("ready")
    } finally {
      vi.useRealTimers()
    }
  })
})
