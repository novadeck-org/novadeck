import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { BoxProfile, InputBox } from "./box/box.js"
import { BoxNotCleared, Interrupts, type InterruptHost } from "./interrupts.js"
import type { InputEntry } from "./queue.js"
import { screen as screenOf } from "./testing/screens.js"

const ESC = "\x1b"
const CLEAR = "<clear>"
const ONE = "<one>"
const PENDING = "Esc again to clear"

/**
 * A terminal as interrupts see it: a one-box screen led by `> `, whose text the test sets
 * as each Escape comes (what the TUI puts back), and the keys written to it.
 */
const terminal = (
  options: {
    /** The turn's prompt, as its hooks told it. */
    prompt?: string
    /** What the box holds before the Escape. */
    draft?: string
    /** Whether its turn works, or how it says so as each key comes. */
    working?: boolean | (() => boolean)
    /** Whether the screen shows messages queued behind the turn, or how it does as it's read. */
    queued?: boolean | (() => boolean)
    /** How the screen says its queued messages are still going through hooks, as it's read. */
    queueing?: () => boolean
    /** How long it waits on that, in milliseconds. */
    queueingMs?: number
    /** Whether the profile has keys that clear its box; they empty it where it `clears`. */
    clear?: boolean
    clears?: boolean
    /**
     * Whether the first clear keys leave the box as it was, its footer saying one more key
     * clears it (a TUI slow to take them, as one TUI's first Escape of a pair), and
     * only a single key then empties it.
     */
    slow?: boolean
    /** How long after the first clear keys the screen shows any sign of them (a hint). */
    hintAfterMs?: number
    /** What the box holds once the nth Escape has come. */
    /** The most rows the box shows of a taller text, as its TUI's `viewport` says. */
    viewport?: number
    after?: (escapes: number) => string | undefined
    /** A row far from the box that counts up by itself, which the profile's calm reads without. */
    ticking?: boolean
    /** What the person types once the box has read the same text twice, as the clear is decided. */
    typesOnSteady?: string
    /** How many reads running of the same text come before they show (2 if absent). */
    steadyReads?: number
    /** How long after an interrupt the next one of the terminal waits, in milliseconds. */
    settleMs?: number
  } = {},
) => {
  const began = Date.now()
  let box = options.draft ?? ""
  let pending = false
  const typed: string[] = []
  const written: string[] = []
  // Whether the person's keys were held as each key was written.
  const heldAtWrites: boolean[] = []
  const profile: BoxProfile = {
    read: (screen: ScreenText): InputBox | undefined => {
      const first = screen.rows.findIndex((row) => row.startsWith("> "))
      if (first < 0) return undefined
      let last = first
      while (screen.rows[last + 1]?.startsWith("  ")) last += 1
      const lines = screen.rows.slice(first, last + 1).map((row) => row.slice(2))
      return { text: lines.join("\n").trimEnd(), mode: "prompt", first, last }
    },
    collapsed: ({ text }) => /^\[Pasted text #\d+ \+\d+ lines\]$/.test(text),
    ...(options.clear === false
      ? {}
      : {
          clear: (_box: InputBox, screen?: ScreenText) =>
            screen?.rows.includes(PENDING) ? ONE : CLEAR,
        }),
    shell: { expands: true, starts: false, footer: () => false },
    queued: () =>
      typeof options.queued === "function" ? options.queued() : options.queued === true,
    ...(options.queueing === undefined ? {} : { queueing: options.queueing }),
    collapses: () => false,
    overlay: () => false,
    ...(options.viewport === undefined ? {} : { viewport: () => options.viewport! }),
    room: (rows) => rows - 3,
    still: (rows) => rows.map((row) => row.replace(/^agent \d+s$/, "agent")),
  }
  // How many reads running have shown the box holding the same text.
  let typesOnSteady = options.typesOnSteady
  let steady = 0
  let last: string | undefined
  // The input holds an entry took, and whether one is in force.
  const holds: { held: boolean; settled: boolean }[] = []
  const host: InterruptHost = {
    admit: () => undefined,
    working: () =>
      typeof options.working === "function" ? options.working() : options.working !== false,
    alive: () => true,
    profile: () => profile,
    prompt: () => options.prompt,
    screen: () => {
      if (typesOnSteady !== undefined && steady >= (options.steadyReads ?? 2)) {
        box = typesOnSteady
        typesOnSteady = undefined
      }
      steady = box !== "" && box === last ? steady + 1 : box === "" ? 0 : 1
      last = box
      return Promise.resolve(
        screenOf({
          rows: [
            options.ticking ? `agent ${Math.floor((Date.now() - began) / 50)}s` : "header",
            ...box.split("\n").map((line, index) => `${index === 0 ? ">" : " "} ${line}`),
            pending ? PENDING : "footer",
          ],
        }),
      )
    },
    type: (_id, data) => {
      typed.push(data)
      const next = options.after?.(typed.length)
      if (next !== undefined) box = next
      return true
    },
    write: (_id, data) => {
      written.push(data)
      heldAtWrites.push(holds.some((hold) => hold.held))
      if (data === CLEAR && options.slow) {
        if (options.hintAfterMs === undefined) pending = true
        else setTimeout(() => (pending = true), options.hintAfterMs).unref()
      } else if (data === CLEAR && options.clears !== false) box = ""
      else if (data === ONE) {
        box = ""
        pending = false
      }
      return true
    },
  }
  const interrupts = new Interrupts(host, {
    restoreMs: 600,
    restoreCalmMs: 100,
    settleMs: options.settleMs ?? 0,
    queuedTurnMs: 1_000,
    ...(options.queueingMs === undefined ? {} : { queueingMs: options.queueingMs }),
  })
  const entry: InputEntry = {
    hold: () => {
      const hold = { held: true, settled: false }
      holds.push(hold)
      return {
        release: () => (hold.held = false),
        settle: () => Object.assign(hold, { held: false, settled: true }),
        settleAfter: () => {},
        holding: () => hold.held,
        discard: () => {},
      }
    },
  }
  return {
    interrupt: () => interrupts.interrupt("terminal"),
    /** The interrupt in its turn of the input queue, which holds the person's keys. */
    interruptIn: () => interrupts.interrupt("terminal", entry),
    holds,
    heldAtWrites,
    typed,
    written,
    // The person's own typing, which the box shows.
    personTypes: (text: string) => {
      box = text
    },
  }
}

describe("interrupts", () => {
  it("presses nothing at a turn that is not working", async () => {
    const t = terminal({ working: false, prompt: "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([])
    expect(t.written).toEqual([])
  })

  it("presses Escape over a draft and leaves the box alone, returning nothing", async () => {
    const t = terminal({ draft: "my draft", prompt: "Say hi", after: () => "my draft Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([])
  })

  it("clears the turn's own prompt that the TUI put back, and returns nothing", async () => {
    const t = terminal({ prompt: "Say hi", after: () => "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([CLEAR])
  })

  it("leaves the box and says so where its TUI has no keys to clear it", async () => {
    const t = terminal({ clear: false, prompt: "Say hi", after: () => "Say hi" })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([])
  })

  it("leaves a placeholder that is not for the turn's own prompt, and says so", async () => {
    const t = terminal({ prompt: "Say hi", after: () => "[Pasted text #1 +4 lines]" })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([])
  })

  it("leaves a placeholder for a long prompt, which no TUI is known to put back", async () => {
    const t = terminal({ prompt: "Say hi\nthere", after: () => "[Pasted text #1 +4 lines]" })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([])
  })

  it("clears the tail of a prompt too tall for the box, which is the turn's own, and returns nothing", async () => {
    const prompt = ["Hold on", "two", "three", "four", "five"].join("\n")
    const t = terminal({ viewport: 3, prompt, after: () => "three\nfour\nfive" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.written).toEqual([CLEAR])
  })

  it("returns the words of a box shorter than the TUI's tallest, though they end the prompt", async () => {
    const prompt = ["Hold on", "two", "three", "four", "five"].join("\n")
    const t = terminal({ viewport: 3, prompt, after: () => "four\nfive" })
    expect(await t.interrupt()).toEqual({ returned: "four\nfive" })
    expect(t.written).toEqual([CLEAR])
  })

  it("takes no box for full on a screen too small to know its viewport, returning the words that end the prompt", async () => {
    const prompt = ["Hold on", "two", "three"].join("\n")
    for (const viewport of [-2, 0, 1]) {
      const t = terminal({ viewport, prompt, after: () => "three" })
      // eslint-disable-next-line no-await-in-loop -- One after the other.
      expect(await t.interrupt()).toEqual({ returned: "three" })
    }
  })

  it("returns the words of a tall box that do not end the prompt", async () => {
    const t = terminal({ viewport: 2, prompt: "Hold on\ntwo\nthree", after: () => "one\nthree" })
    expect(await t.interrupt()).toEqual({ returned: "one\nthree" })
  })

  it("says so when the clear keys leave the box holding text", async () => {
    const t = terminal({ clears: false, prompt: "Say hi", after: () => "Say hi" })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([CLEAR, CLEAR, CLEAR])
  })

  it("writes a single key for the clear its footer says is half done, not the pair again", async () => {
    const t = terminal({ slow: true, prompt: "Say hi", after: () => "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.written).toEqual([CLEAR, ONE])
  })

  it("waits for a TUI slow to take the first clear keys, not writing a pair over them", async () => {
    // The screen shows no sign of them for longer than the calm a box is given, as one TUI did
    // on a busy Windows machine; its hint then says one more key clears it.
    const t = terminal({ slow: true, hintAfterMs: 300, prompt: "Say hi", after: () => "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.written).toEqual([CLEAR, ONE])
  })

  it("writes the keys again once nothing of them shows within the time it waits", async () => {
    const t = terminal({ slow: true, hintAfterMs: 5_000, prompt: "Say hi", after: () => "Say hi" })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([CLEAR, CLEAR, CLEAR])
  })

  it("presses Escape again for queued messages and returns what came back, cleared", async () => {
    const t = terminal({
      queued: true,
      prompt: "Hold on",
      after: (escapes) => (escapes === 2 ? "Queued beta\nQueued gamma" : undefined),
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta\nQueued gamma" })
    expect(t.typed).toEqual([ESC, ESC])
    expect(t.written).toEqual([CLEAR])
  })

  it("holds its first Escape while queued messages go through their hooks", async () => {
    const started = Date.now()
    const atEscape: number[] = []
    const t = terminal({
      queued: true,
      queueing: () => Date.now() - started < 200,
      prompt: "Hold on",
      working: () => {
        if (t.typed.length === 1 && atEscape.length === 0) atEscape.push(Date.now() - started)
        return true
      },
      after: (escapes) => (escapes === 2 ? "Queued beta\nQueued gamma" : undefined),
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta\nQueued gamma" })
    expect(atEscape[0]).toBeGreaterThanOrEqual(190)
    expect(t.typed).toEqual([ESC, ESC])
  })

  it("presses its Escape at once where the screen says of no hook", async () => {
    const t = terminal({
      queued: true,
      queueing: () => false,
      queueingMs: 60_000,
      prompt: "Hold on",
      after: (escapes) => (escapes === 2 ? "Queued beta" : undefined),
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta" })
  })

  it("holds no Escape for a hook with nothing queued", async () => {
    const t = terminal({ queueing: () => true, queueingMs: 60_000, prompt: "Hold on" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC])
  })

  it("goes on as ever once the hold's bound runs out", async () => {
    const started = Date.now()
    const t = terminal({
      queued: true,
      queueing: () => true,
      queueingMs: 150,
      prompt: "Hold on",
      after: (escapes) => (escapes === 2 ? "Queued beta" : undefined),
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta" })
    expect(t.typed).toEqual([ESC, ESC])
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  it("presses nothing where the turn ends during the hold", async () => {
    let done = false
    setTimeout(() => (done = true), 100).unref()
    const t = terminal({
      queued: true,
      queueing: () => true,
      queueingMs: 60_000,
      working: () => !done,
    })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([])
  })

  it("presses the second Escape for queued messages only once their turn works", async () => {
    // The stopped turn ends, and the TUI starts the queued one 300 ms after the Escape,
    // as a busy machine may, past when the box has settled.
    const pressed: number[] = []
    const t = terminal({
      queued: true,
      prompt: "Hold on",
      working: () => pressed.length === 0 || Date.now() - pressed[0]! >= 300,
      after: (escapes) => {
        pressed.push(Date.now())
        return escapes === 2 ? "Queued beta" : undefined
      },
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta" })
    expect(t.typed).toEqual([ESC, ESC])
    expect(pressed[1]! - pressed[0]!).toBeGreaterThanOrEqual(300)
  })

  it("waits for the queued turn, whatever the screen says of the queue", async () => {
    // The queue leaves the screen at the Escape; its turn shows working only at 600 ms, as a
    // hook held back would: the second Escape waits for it.
    const pressed: number[] = []
    const since = () => (pressed.length === 0 ? 0 : Date.now() - pressed[0]!)
    const queued = {
      queued: () => pressed.length === 0,
      prompt: "Hold on",
      working: () => pressed.length === 0 || since() >= 600,
    }
    const waits = terminal({
      ...queued,
      after: (escapes) => {
        pressed.push(Date.now())
        return escapes === 2 ? "Queued beta" : undefined
      },
    })
    expect(await waits.interrupt()).toEqual({ returned: "Queued beta" })
    expect(pressed[1]! - pressed[0]!).toBeGreaterThanOrEqual(600)
  }, 10_000)

  it("leaves what the person typed while no queued turn came, pressing no second Escape over it", async () => {
    const t = terminal({ queued: true, prompt: "Hold on", working: () => t.typed.length === 0 })
    const stopping = t.interrupt()
    await new Promise((resolve) => setTimeout(resolve, 300))
    t.personTypes("mine")
    expect(await stopping).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([])
  })

  it("presses the second Escape once the cap passes with no queued turn and an empty box", async () => {
    const pressed: number[] = []
    const t = terminal({
      queued: true,
      prompt: "Hold on",
      working: () => pressed.length === 0,
      after: () => {
        pressed.push(Date.now())
        return undefined
      },
    })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC, ESC])
    // The stub's cap is 1 s.
    expect(pressed[1]! - pressed[0]!).toBeGreaterThanOrEqual(1_000)
  })

  it("returns the person's text with the queued one where the queued turn came after they typed", async () => {
    const pressed: number[] = []
    const t = terminal({
      queued: true,
      prompt: "Hold on",
      working: () => pressed.length === 0 || Date.now() - pressed[0]! >= 600,
      // The second Escape stops the queued turn, which puts its message after theirs.
      after: (escapes) => {
        pressed.push(Date.now())
        return escapes === 2 ? "mine\nQueued beta" : undefined
      },
    })
    const stopping = t.interrupt()
    // Past the box settling after the first Escape, before the queued turn comes.
    await new Promise((resolve) => setTimeout(resolve, 350))
    t.personTypes("mine")
    expect(await stopping).toEqual({ returned: "mine\nQueued beta" })
    expect(t.typed).toEqual([ESC, ESC])
  })

  it("waits out a TUI slow to take the clear keys while a row far from the box counts up", async () => {
    // A background agent's elapsed time ticks each 50 ms, which the profile's calm reads
    // without: no sign of the keys taken, so no second pair goes over the first.
    const t = terminal({
      slow: true,
      hintAfterMs: 300,
      ticking: true,
      prompt: "Say hi",
      after: () => "Say hi",
    })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.written).toEqual([CLEAR, ONE])
  })

  it("leaves the box, and says so, where the person typed into it as the clear was decided", async () => {
    const t = terminal({
      prompt: "Say hi",
      after: () => "Say hi",
      typesOnSteady: "Say hix",
    })
    await expect(t.interrupt()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([])
  })

  it("leaves the box where the person's key shows only on its second read under the hold", async () => {
    const t = terminal({
      prompt: "Say hi",
      after: () => "Say hi",
      typesOnSteady: "Say hix",
      steadyReads: 3,
    })
    await expect(t.interruptIn()).rejects.toBeInstanceOf(BoxNotCleared)
    expect(t.written).toEqual([])
    expect(t.holds).toEqual([{ held: false, settled: true }])
  })

  it("holds the person's keys in its turn of the input queue while it clears, then lets them go", async () => {
    const t = terminal({
      slow: true,
      hintAfterMs: 300,
      prompt: "Say hi",
      after: () => "Say hi",
    })
    expect(await t.interruptIn()).toEqual({ returned: undefined })
    expect(t.written).toEqual([CLEAR, ONE])
    expect(t.heldAtWrites).toEqual([true, true])
    expect(t.holds).toEqual([{ held: false, settled: true }])
  })

  it("holds nothing where nothing is cleared", async () => {
    const t = terminal({ prompt: "Say hi" })
    expect(await t.interruptIn()).toEqual({ returned: undefined })
    expect(t.holds).toEqual([])
  })

  it("keeps the next interrupt waiting only after one that pressed Escape", async () => {
    const idle = terminal({ working: false, settleMs: 5_000 })
    await idle.interrupt()
    const started = Date.now()
    await idle.interrupt()
    expect(Date.now() - started).toBeLessThan(1_000)
    const working = terminal({ settleMs: 300 })
    await working.interrupt()
    const next = Date.now()
    await working.interrupt()
    expect(Date.now() - next).toBeGreaterThanOrEqual(250)
  })

  it("returns nothing where the first Escape alone leaves the box empty and nothing is queued", async () => {
    const t = terminal({ prompt: "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: undefined })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([])
  })
})
