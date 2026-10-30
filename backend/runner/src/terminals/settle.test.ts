import { randomUUID } from "node:crypto"

import type { ScreenText } from "@novadeck/emulator/headless"
import { hookShellSlackMs } from "@novadeck/harness-core/hook-command"
import { screen as screenWith } from "@novadeck/harness-core/testing/screens"
import type { TerminalEvent } from "@novadeck/protocol"
import { command } from "@novadeck/terminal/testing"
import { vi } from "vitest"

import { started } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { submitWindowMs } from "../messaging/delivery.js"
import { describe, expect, it } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"
import { Terminals } from "./manager.js"
import type { Bound } from "./record.js"

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

/** A session bound with its fresh activity, as its first report binds it. */
const bound = (binding: Binding): Bound => ({ binding, activity: started(0), telemetry: null })

describe("settling a draft kept only by doubt", () => {
  type Inside = {
    records: Map<string, { bound: Bound | null }>
    typing: {
      screenOf: (id: string) => Promise<unknown>
      settleBox: (record: unknown) => void
    }
    messaging: {
      rooted: (id: string, changes: readonly unknown[]) => void
      observe: (id: string, events: readonly unknown[]) => void
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
  const doubting = async (
    terminals: ReturnType<typeof fixture>,
    reads: unknown[],
    completed = false,
  ) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    record.bound = bound({ agent: "agy", sessionId: "s", instance: null })
    const { messaging } = inside
    messaging.rooted(terminal.id, [root("a")])
    messaging.keys(terminal.id, ["content", "enter"], false)
    let looked = 0
    inside.typing.screenOf = () => Promise.resolve(reads[Math.min(looked++, reads.length - 1)])
    return {
      manager,
      inside,
      record,
      id: terminal.id,
      looks: () => looked,
      state: () => messaging.delivery(terminal.id)?.state,
      start: () => {
        // Start after the fake clock and screen reader are installed: delivery changes
        // now start the manager's settling automatically, including a completed Stop.
        if (completed) {
          const identity = { agent: "agy", sessionId: "a", instance: null }
          messaging.observe(terminal.id, [
            { ...identity, type: "turn-started", cause: "prompt", startedAt: root("a").startedAt },
            { ...identity, type: "turn-ended", outcome: "completed" },
          ])
        } else messaging.rooted(terminal.id, [root("b")])
        expect(messaging.delivery(terminal.id)).toMatchObject({
          state: "drafting",
          box: { doubted: true },
        })
      },
    }
  }

  it("is Ready once the box reads empty twice running, and not after one empty read", async ({
    resources,
  }) => {
    const settled = await doubting(fixture(resources), [empty, empty])
    const between = await doubting(fixture(resources), [empty, typed, empty, typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      settled.start()
      between.start()
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

  it("automatically becomes Settled after a late prompt's completed turn and two empty reads", async ({
    resources,
  }) => {
    const reading = await doubting(fixture(resources), [empty], true)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      reading.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(reading.state()).toBe("drafting")
      expect(reading.looks()).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(reading.state()).toBe("settled")
      expect(reading.looks()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("settles a new doubt after the terminal restarts and its delivery epochs begin again", async ({
    resources,
  }) => {
    const manager = fixture(resources).manager({ ...ptyOptions, transcripts: false })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    const { messaging } = inside
    const attach = () => {
      const controller = new AbortController()
      const stream = manager.attach(
        { terminalId: terminal.id, mode: "observe" },
        "observer",
        controller.signal,
      )
      resources.defer(async () => {
        controller.abort()
        await stream.return(undefined)
      })
      return stream
    }
    const until = async (
      stream: ReturnType<Terminals["attach"]>,
      matches: (event: TerminalEvent, output: string) => boolean | Promise<boolean>,
    ) => {
      let output = ""
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- Leave the attachment open for the next read.
        const result = await stream.next()
        if (result.done) throw new Error("The terminal ended before the expected output or exit.")
        const event = result.value
        if (event.type === "attached") continue
        if (event.type === "output" || event.type === "snapshot") output += event.data
        manager.ack({ terminalId: terminal.id, sequence: event.sequence }, "observer")
        // eslint-disable-next-line no-await-in-loop -- Each screen check follows its output event.
        if (await matches(event, output)) return
      }
    }
    const draw = async (stream: ReturnType<Terminals["attach"]>) => {
      await until(stream, (_event, output) => output.includes("PTY_READY"))
      // A real empty box on the runner's screen, not a replacement screen reader.
      const drawing = `\x1b[2J\x1b[H${rule}\r\n> \r\n${rule}\x1b[2;3H`
      manager.write(
        { terminalId: terminal.id, data: command({ type: "write", data: drawing }) },
        "creator",
      )
      await until(stream, async (event) => {
        if (event.type !== "output") return false
        const screen = (await inside.typing.screenOf(terminal.id)) as ScreenText | undefined
        return (
          screen?.rows[0] === rule &&
          screen.rows[2] === rule &&
          screen.cursor.row === 1 &&
          screen.cursor.column === 2
        )
      })
    }
    const settle = async (sessionId: string, next: string) => {
      record.bound = bound({ agent: "agy", sessionId, instance: null })
      messaging.rooted(terminal.id, [root(sessionId)])
      messaging.keys(terminal.id, ["content", "enter"], false)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        messaging.rooted(terminal.id, [root(next)])
        expect(messaging.delivery(terminal.id)).toMatchObject({
          state: "drafting",
          epoch: 2,
          box: { doubted: true },
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(messaging.delivery(terminal.id).state).toBe("drafting")
        await vi.advanceTimersByTimeAsync(100)
        expect(messaging.delivery(terminal.id)).toMatchObject({ state: "ready", epoch: 2 })
      } finally {
        vi.useRealTimers()
      }
    }

    const first = attach()
    await draw(first)
    await settle("a", "b")
    manager.write({ terminalId: terminal.id, data: command({ type: "exit", code: 0 }) }, "creator")
    await until(first, (event) => event.type === "exited")
    await first.return(undefined)
    expect(messaging.delivery(terminal.id)).toBeUndefined()

    await manager.restart({ terminalId: terminal.id, cols: 80, rows: 24 }, "creator")
    expect(inside.records.get(terminal.id)).toBe(record)
    expect(messaging.delivery(terminal.id).epoch).toBe(0)
    const restarted = attach()
    await draw(restarted)
    await settle("c", "d")
  })

  it.for(["empty", "draft", "queued"] as const)(
    "recovers a late post-interruption prompt only with an %s screen",
    async (screen, { resources }) => {
      const manager = fixture(resources).manager({ ...ptyOptions, platform: "win32" })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "creator",
      )
      const inside = manager as unknown as Inside
      const record = inside.records.get(terminal.id)!
      const identity = { agent: "codex", sessionId: "a", instance: null } as const
      record.bound = bound(identity)
      let reads = 0
      inside.typing.screenOf = () => {
        reads += 1
        return Promise.resolve(
          screenWith({
            rows: [
              screen === "draft" ? "› another draft" : "› ",
              screen === "queued" ? "Messages to be submitted after next tool call" : "",
            ],
            cursor: { row: 0, column: screen === "draft" ? 15 : 2 },
          }),
        )
      }
      const { messaging } = inside
      const at = Date.now()
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        messaging.rooted(terminal.id, [
          {
            type: "new",
            root: { ...identity, source: "binding" },
            guess: false,
            ready: true,
            startedAt: at,
          },
        ])
        messaging.observe(terminal.id, [
          { ...identity, type: "turn-started", cause: "harness", startedAt: at },
        ])
        vi.setSystemTime(at + 3432)
        messaging.keys(terminal.id, ["escape"], false)
        vi.setSystemTime(at + 7347)
        messaging.keys(terminal.id, ["content"], false)
        vi.setSystemTime(at + 7525)
        messaging.keys(terminal.id, ["enter"], false)
        vi.setSystemTime(at + 12433)
        messaging.observe(terminal.id, [
          {
            ...identity,
            type: "turn-started",
            cause: "prompt",
            startedAt: at + 12427.8293,
            firedAt: at + 11996,
          },
        ])
        vi.setSystemTime(at + 12977)
        messaging.observe(terminal.id, [
          { ...identity, type: "turn-ended", outcome: "completed", startedAt: at + 12974 },
        ])
        expect(messaging.delivery(terminal.id)).toMatchObject({
          state: "drafting",
          byPerson: false,
          box: { doubted: true },
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(reads).toBe(1)
        expect(messaging.delivery(terminal.id).state).toBe("drafting")
        await vi.advanceTimersByTimeAsync(100)
        expect(messaging.delivery(terminal.id)).toMatchObject({
          state: screen === "empty" ? "settled" : "drafting",
          byPerson: false,
        })
        expect(reads).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it("gives up after its window, leaving the draft", async ({ resources }) => {
    const drafted = await doubting(fixture(resources), [typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      drafted.start()
      await vi.advanceTimersByTimeAsync(5_200)
      const looked = drafted.looks()
      expect(looked).toBeGreaterThan(40)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(drafted.looks()).toBe(looked)
      expect(drafted.state()).toBe("drafting")
      // Another terminal change must not restart the same doubt's five-second budget.
      drafted.inside.typing.settleBox(drafted.record)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(drafted.looks()).toBe(looked)
      // A later doubt has a new epoch and gets its own budget automatically.
      drafted.inside.messaging.keys(drafted.id, ["content", "enter"], false)
      drafted.inside.messaging.rooted(drafted.id, [root("c")])
      expect(drafted.inside.messaging.delivery(drafted.id)).toMatchObject({
        state: "drafting",
        box: { doubted: true },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(drafted.looks()).toBeGreaterThan(looked)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops looking when the terminal ends", async ({ resources }) => {
    const reading = await doubting(fixture(resources), [typed])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      reading.start()
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
      reading.start()
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
      reading.inside.typing.screenOf = async () => {
        const screen = screens.shift() ?? empty
        if (screens.length === 0 && release === undefined)
          await new Promise<void>((resolve) => (release = resolve))
        return screen
      }
      reading.start()
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
