import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import type { TerminalRecords, TerminalToSave } from "./records.js"
import type { TranscriptRedactor } from "./redaction.js"
import { Saves, type SavedRecord, type SavesOptions } from "./saving.js"

// A screen here is its text.
vi.mock("@novadeck/emulator/headless", () => ({
  transcript: (screen: { text: string }) => screen.text,
}))

const saveMs = 1000
const transcriptMs = 10_000

type Fake = {
  saves: Saves
  written: TerminalToSave[]
  clears: number
  /** The redactions asked for, each settled by hand. */
  asked: {
    text: string
    signal: AbortSignal | undefined
    settle: (r: string | null | undefined) => void
  }[]
  state: { stopping: boolean; stopped: boolean }
  records: SavedRecord[]
  closes: number
}

const record = (id: string, text = "screen"): SavedRecord =>
  ({
    summary: {
      id,
      sessionId: "s",
      handle: id,
      ledBy: null,
      command: null,
      lastProgram: null,
      cwd: "/",
    },
    naming: null,
    openedBy: null,
    work: null,
    agents: {},
    promptedAt: null,
    closed: false,
    changed: true,
    savedAt: 0,
    terminal: { screen: { text, cols: 80, buffer: { normal: { length: 24 } } } },
  }) as unknown as SavedRecord

/** A redactor that masks "secret" at once, or waits for the test to settle each call. */
const make = (options: Partial<SavesOptions> = {}, mode: "now" | "manual" = "now"): Fake => {
  const fake: Fake = {
    written: [],
    clears: 0,
    asked: [],
    state: { stopping: false, stopped: false },
    records: [record("a")],
    closes: 0,
    saves: undefined as unknown as Saves,
  }
  const records = {
    saveTerminal: (terminal: TerminalToSave) => void fake.written.push(terminal),
    clearTranscripts: () => void fake.clears++,
  } as unknown as TerminalRecords
  const redactor: TranscriptRedactor = {
    redact: ({ text }, signal) =>
      mode === "now"
        ? Promise.resolve(text.replaceAll("secret", "*"))
        : new Promise((settle) => {
            fake.asked.push({ text, signal, settle })
          }),
    close: async () => void fake.closes++,
  }
  fake.saves = new Saves(
    {
      records,
      saveMs,
      transcriptMs,
      shutdownMs: 500,
      transcriptChars: 1000,
      transcripts: true,
      redactor,
      ...options,
    },
    {
      stopping: () => fake.state.stopping,
      stopped: () => fake.state.stopped,
      records: () => fake.records,
    },
  )
  return fake
}

const transcripts = (fake: Fake) => fake.written.filter((row) => row.transcript !== undefined)

describe("saving terminals", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("saves everything but the transcript as soon as saveMs has passed, the transcript on its own turn", async () => {
    const fake = make()
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    // The first screen goes soon: nothing has been saved of it yet.
    expect(transcripts(fake)).toHaveLength(1)
    expect(
      fake.written.every((row) => row.transcript === undefined || row.transcript === "screen"),
    ).toBe(true)
    const before = fake.written.length
    fake.records[0]!.changed = true
    ;(fake.records[0]!.terminal.screen as unknown as { text: string }).text = "next secret"
    await vi.advanceTimersByTimeAsync(saveMs * 2)
    // Other state follows the change within a couple of ticks; the transcript waits.
    expect(fake.written.length).toBeGreaterThan(before)
    expect(transcripts(fake)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(transcriptMs)
    expect(transcripts(fake)).toHaveLength(2)
    expect(transcripts(fake)[1]?.transcript).toBe("next *")
    fake.saves.stop()
  })

  it("saves nothing unredacted: a screen that could not be redacted keeps the copy before it, and is tried again later and later", async () => {
    const fake = make({}, "manual")
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    fake.asked[0]!.settle("first")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["first"])
    const attempts: number[] = []
    for (let tries = 0; tries < 3; tries++) {
      fake.records[0]!.changed = true
      const start = fake.asked.length
      const began = Date.now()
      // eslint-disable-next-line no-await-in-loop -- Time passes between tries.
      while (fake.asked.length === start) await vi.advanceTimersByTimeAsync(saveMs / 5)
      attempts.push(Date.now() - began)
      fake.asked[start]!.settle(null)
      // eslint-disable-next-line no-await-in-loop -- Time passes between tries.
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["first"])
    // Each wait is longer than the one before.
    expect(attempts[1]!).toBeGreaterThan(attempts[0]!)
    expect(attempts[2]!).toBeGreaterThan(attempts[1]!)
    expect(fake.records[0]!.changed).toBe(true)
    fake.saves.stop()
  })

  it("redacts one screen at a time", async () => {
    const fake = make({}, "manual")
    fake.records = [record("a"), record("b")]
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    expect(fake.asked).toHaveLength(1)
    fake.asked[0]!.settle("x")
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.asked).toHaveLength(2)
    fake.saves.stop()
  })

  it("saves a screen at once as its shell ends", async () => {
    const fake = make()
    fake.records[0]!.changed = false
    fake.saves.save(fake.records[0]!, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["screen"])
  })

  it("drops a result that arrives after the terminal was closed", async () => {
    const fake = make({}, "manual")
    fake.saves.save(fake.records[0]!, true)
    fake.records[0]!.closed = true
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toEqual([])
  })

  it("drops a result that arrives after transcripts were turned off, even if turned on again", async () => {
    const fake = make({}, "manual")
    fake.saves.save(fake.records[0]!, true)
    fake.saves.keep(false)
    expect(fake.clears).toBe(1)
    expect(fake.asked[0]!.signal?.aborted).toBe(true)
    fake.saves.keep(true)
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).not.toContain("late")
  })

  it("drops a result that arrives once the runner is stopping", async () => {
    const fake = make({}, "manual")
    fake.saves.save(fake.records[0]!, true)
    fake.state.stopping = true
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toEqual([])
  })

  it("saves no transcript while they are off", async () => {
    const fake = make({ transcripts: false })
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs * 3)
    expect(transcripts(fake)).toEqual([])
    expect(fake.records[0]!.changed).toBe(false)
    fake.saves.keep(true)
    expect(fake.records[0]!.changed).toBe(true)
    fake.saves.stop()
  })

  it("gives the transcripts a pass as it shuts down, then closes the redactor", async () => {
    const fake = make()
    fake.records = [record("a", "one secret"), record("b", "two")]
    const done = fake.saves.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["one *", "two"])
    expect(fake.closes).toBe(1)
  })

  it("writes the last pass while the runner is stopping, but not past its budget", async () => {
    const fake = make({}, "manual")
    fake.records = [record("a"), record("b")]
    const done = fake.saves.shutdown()
    fake.state.stopping = true
    fake.asked[0]!.settle("first")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["first"])
    await vi.advanceTimersByTimeAsync(500)
    await done
    // The second never came back: it keeps its last saved copy.
    expect(transcripts(fake)).toHaveLength(1)
    expect(fake.records[1]!.changed).toBe(true)
    expect(fake.asked[1]!.signal?.aborted).toBe(true)
  })

  it("starts the same pass without waiting when the system is shutting down", async () => {
    const fake = make()
    fake.saves.persist()
    // Other state is written before persist returns.
    expect(fake.written.filter((row) => row.transcript === undefined)).toHaveLength(1)
    expect(transcripts(fake)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toHaveLength(1)
  })
})
