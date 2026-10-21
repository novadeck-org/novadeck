import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { plainSealer, sealed, unsealed } from "../testing/sealing.js"
import type { SavedTerminal, TerminalRecords, TerminalToSave } from "./records.js"
import type { TranscriptRedactor } from "./redaction.js"
import { Saves, type SavedRecord, type SavesOptions } from "./saving.js"
import { sealedShape, type TranscriptSealer } from "./sealing.js"

// A screen here is its text.
vi.mock("@novadeck/emulator/headless", () => ({
  transcript: (screen: { text: string }) => screen.text,
}))

const saveMs = 1000
const transcriptMs = 10_000

type Fake = {
  saves: Saves
  /** What was saved, its transcript unsealed. */
  written: TerminalToSave[]
  /** The transcripts as saved, sealed. */
  sealed: (string | null)[]
  clears: number
  /** How often the records were told to forget the unsealed ones, and by what shape. */
  forgets: (typeof sealedShape)[]
  /** The redactions asked for, each settled by hand. */
  asked: {
    text: string
    signal: AbortSignal | undefined
    settle: (r: string | null | undefined) => void
  }[]
  state: { stopping: boolean; stopped: boolean }
  records: SavedRecord[]
  closes: number
  /** Metadata saves fail. */
  refuse: boolean
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
    screenChanged: true,
    savedAt: 0,
    terminal: { screen: { text, cols: 80, buffer: { normal: { length: 24 } } } },
  }) as unknown as SavedRecord

/** A redactor that masks "secret" at once, or waits for the test to settle each call. */
const make = (options: Partial<SavesOptions> = {}, mode: "now" | "manual" = "now"): Fake => {
  const fake: Fake = {
    written: [],
    sealed: [],
    forgets: [],
    clears: 0,
    asked: [],
    state: { stopping: false, stopped: false },
    records: [record("a")],
    closes: 0,
    refuse: false,
    saves: undefined as unknown as Saves,
  }
  const records = {
    saveTerminal: (terminal: TerminalToSave) => {
      if (fake.refuse && terminal.transcript === undefined) throw new Error("disk full")
      if (typeof terminal.transcript === "string") fake.sealed.push(terminal.transcript)
      fake.written.push(
        typeof terminal.transcript === "string"
          ? { ...terminal, transcript: unsealed(terminal.transcript, terminal.id) }
          : terminal,
      )
    },
    forgetUnsealed: (shape: typeof sealedShape) => void fake.forgets.push(shape),
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
      sealer: plainSealer(),
      keyMs: 1000,
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
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    // The first screen goes soon: nothing has been saved of it yet.
    expect(transcripts(fake)).toHaveLength(1)
    expect(
      fake.written.every((row) => row.transcript === undefined || row.transcript === "screen"),
    ).toBe(true)
    const before = fake.written.length
    fake.records[0]!.changed = true
    fake.records[0]!.screenChanged = true
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
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    fake.asked[0]!.settle("first")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["first"])
    const attempts: number[] = []
    for (let tries = 0; tries < 3; tries++) {
      fake.records[0]!.screenChanged = true
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
    expect(fake.records[0]!.screenChanged).toBe(true)
    fake.saves.stop()
  })

  it("redacts one screen at a time", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
    fake.records[0]!.screenChanged = false
    fake.saves.save(fake.records[0]!, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["screen"])
  })

  it("drops a result that arrives after the terminal was closed", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.save(fake.records[0]!, true)
    fake.records[0]!.closed = true
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toEqual([])
  })

  it("drops a result that arrives after transcripts were turned off, even if turned on again", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.save(fake.records[0]!, true)
    fake.state.stopping = true
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toEqual([])
  })

  it("saves no transcript while they are off", async () => {
    const fake = make({ transcripts: false })
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs * 3)
    expect(transcripts(fake)).toEqual([])
    expect(fake.records[0]!.changed).toBe(false)
    fake.saves.keep(true)
    expect(fake.records[0]!.screenChanged).toBe(true)
    fake.saves.stop()
  })

  it("gives the transcripts a pass as it shuts down, then closes the redactor", async () => {
    const fake = make()
    await vi.advanceTimersByTimeAsync(0)
    fake.records = [record("a", "one secret"), record("b", "two")]
    const done = fake.saves.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["one *", "two"])
    expect(fake.closes).toBe(1)
  })

  it("writes the last pass while the runner is stopping, but not past its budget", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
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
    expect(fake.records[1]!.screenChanged).toBe(true)
    expect(fake.asked[1]!.signal?.aborted).toBe(true)
  })

  it("starts the same pass without waiting when the system is shutting down", async () => {
    const fake = make()
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.persist()
    // Other state is written before persist returns.
    expect(fake.written.filter((row) => row.transcript === undefined)).toHaveLength(1)
    expect(transcripts(fake)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake)).toHaveLength(1)
  })

  it("keeps a terminal's other state marked changed while saving it fails, with transcripts off", async () => {
    const fake = make({ transcripts: false })
    await vi.advanceTimersByTimeAsync(0)
    fake.records[0]!.changed = true
    fake.refuse = true
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    error.mockRestore()
    expect(fake.records[0]!.changed).toBe(true)
    fake.refuse = false
    await vi.advanceTimersByTimeAsync(saveMs * 2)
    expect(fake.records[0]!.changed).toBe(false)
    fake.saves.stop()
  })

  it("redacts nothing for a change of its other state alone", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.records[0]!.screenChanged = false
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs * 3)
    expect(fake.asked).toEqual([])
    expect(fake.records[0]!.changed).toBe(false)
    fake.saves.stop()
  })

  it("writes the last pass although the runner has stopped meanwhile, until the pass is over", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    const done = fake.saves.shutdown()
    fake.state.stopping = true
    fake.state.stopped = true
    fake.asked[0]!.settle("late but in time")
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["late but in time"])
  })

  it("waits for the redaction in flight as the system shuts down, redacting that screen once", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.save(fake.records[0]!, true)
    expect(fake.asked).toHaveLength(1)
    fake.saves.persist()
    fake.state.stopping = true
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.asked[0]!.signal?.aborted).toBe(false)
    fake.asked[0]!.settle("once")
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.asked).toHaveLength(1)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["once"])
    expect(fake.records[0]!.screenChanged).toBe(false)
  })

  it("does not save back a terminal removed while its screen was taken or waiting", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.records = [record("a"), record("b")]
    fake.saves.save(fake.records[0]!, true)
    fake.saves.save(fake.records[1]!, true)
    fake.saves.remove("a")
    fake.saves.remove("b")
    fake.asked[0]!.settle("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.asked).toHaveLength(1)
    expect(transcripts(fake)).toEqual([])
  })

  it("saves a screen with nothing on it as no transcript, without the redactor", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    ;(fake.records[0]!.terminal.screen as unknown as { text: string }).text = ""
    fake.saves.save(fake.records[0]!, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.asked).toEqual([])
    expect(transcripts(fake).map((row) => row.transcript)).toEqual([null])
  })

  it("hands the redactor the whole screen to cut after masking", async () => {
    const fake = make({ transcriptChars: 5 }, "manual")
    await vi.advanceTimersByTimeAsync(0)
    ;(fake.records[0]!.terminal.screen as unknown as { text: string }).text = "a long screen"
    fake.saves.save(fake.records[0]!, true)
    expect(fake.asked[0]!.text).toBe("a long screen")
  })

  it("seals the masked transcript just before it is written", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.save(fake.records[0]!, true)
    fake.asked[0]!.settle("masked")
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sealed.map((value) => unsealed(value, "a"))).toEqual(["masked"])
  })

  it("writes no transcript and clears none until the key comes, then saves the screen sealed", async () => {
    let arrive!: (key: boolean) => void
    const sealer: TranscriptSealer = {
      ...plainSealer(),
      ready: new Promise<boolean>((resolve) => (arrive = resolve)),
    }
    const fake = make({ sealer })
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(saveMs * 3)
    expect(transcripts(fake)).toEqual([])
    expect(fake.clears).toBe(0)
    expect(fake.records[0]!.screenChanged).toBe(true)
    arrive(true)
    await vi.advanceTimersByTimeAsync(saveMs + 1)
    expect(fake.sealed.map((value) => unsealed(value, "a"))).toEqual(["screen"])
    // Unsealed copies went as the runner started, key or none.
    expect(fake.forgets).toEqual([sealedShape])
  })

  it("saves no transcript and clears none when there is no key, and forgets the unsealed ones", async () => {
    const fake = make({ sealer: { ...plainSealer(), ready: Promise.resolve(false) } })
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.start()
    fake.saves.save(fake.records[0]!, true)
    fake.saves.persist()
    await vi.advanceTimersByTimeAsync(transcriptMs * 2)
    expect(transcripts(fake)).toEqual([])
    expect(fake.clears).toBe(0)
    expect(fake.forgets).toEqual([sealedShape])
    expect(fake.records[0]!.screenChanged).toBe(true)
    fake.saves.stop()
  })

  it("opens a saved transcript, and gives up on one whose key is late or missing", async () => {
    const saved = {
      id: "a",
      transcript: sealed("old", "a"),
    } as unknown as SavedTerminal
    const fake = make()
    await vi.advanceTimersByTimeAsync(0)
    await expect(fake.saves.open(saved)).resolves.toBe("old")
    await expect(
      fake.saves.open({ ...saved, transcript: "plain" } as SavedTerminal),
    ).resolves.toBeNull()
    const late = make({ sealer: { ...plainSealer(), ready: new Promise(() => {}) } })
    await vi.advanceTimersByTimeAsync(0)
    const waiting = late.saves.open(saved)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(waiting).resolves.toBeNull()
    const none = make({ sealer: { ...plainSealer(), ready: Promise.resolve(false) } })
    await vi.advanceTimersByTimeAsync(0)
    await expect(none.saves.open(saved)).resolves.toBeNull()
    const bare = make({ sealer: undefined })
    await vi.advanceTimersByTimeAsync(0)
    await expect(bare.saves.open(saved)).resolves.toBeNull()
  })

  it("saves nothing over a transcript left unopened because the key came late, and counts the wait once", async () => {
    let arrive!: (key: boolean) => void
    const sealer: TranscriptSealer = {
      ...plainSealer(),
      ready: new Promise<boolean>((resolve) => (arrive = resolve)),
    }
    const fake = make({ sealer })
    await vi.advanceTimersByTimeAsync(0)
    const saved = (id: string) =>
      ({ id, transcript: sealed("old", id) }) as unknown as SavedTerminal
    const first = fake.saves.open(saved("a"))
    await vi.advanceTimersByTimeAsync(600)
    // The wait is one for the run: a restore after it does not wait again.
    const second = fake.saves.open(saved("b"))
    await vi.advanceTimersByTimeAsync(400)
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    arrive(true)
    fake.saves.start()
    await vi.advanceTimersByTimeAsync(transcriptMs * 2)
    expect(transcripts(fake)).toEqual([])
    fake.saves.persist()
    await vi.advanceTimersByTimeAsync(1000)
    expect(transcripts(fake)).toEqual([])
    // A terminal that was never unopened still saves.
    fake.records = [record("c")]
    fake.saves.save(fake.records[0]!, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["screen"])
    fake.saves.stop()
  })

  it("shows nothing when transcripts are turned off while it waits for the key", async () => {
    const fake = make({ sealer: { ...plainSealer(), ready: Promise.resolve(true) } })
    await vi.advanceTimersByTimeAsync(0)
    const saved = {
      id: "a",
      transcript: sealed("old", "a"),
    } as unknown as SavedTerminal
    const opening = fake.saves.open(saved)
    fake.saves.keep(false)
    await expect(opening).resolves.toBeNull()
  })

  it("keeps the copy saved before when a screen cannot be masked", async () => {
    const fake = make({}, "manual")
    await vi.advanceTimersByTimeAsync(0)
    fake.saves.save(fake.records[0]!, true)
    fake.asked[0]!.settle("mine")
    await vi.advanceTimersByTimeAsync(0)
    fake.records[0]!.screenChanged = true
    fake.saves.save(fake.records[0]!, true)
    fake.asked[1]!.settle(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(transcripts(fake).map((row) => row.transcript)).toEqual(["mine"])
    fake.saves.stop()
  })
})
