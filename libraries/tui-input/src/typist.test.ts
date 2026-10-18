import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BoxProfile } from "./box.js"
import type { InputEntry } from "./queue.js"
import { screen } from "./testing/screens.js"
import { createTypist, pasteMsOn, sizeCapMs, type Timing, type Typist } from "./typist.js"

// The clock is fake, so a timing is the same on every machine: the typist's sleeps go through
// the faked setTimeout, and `run` and `sleep` fire each timer as it comes due.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}))

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Runs `work` to its end on the fake clock, stepping from each timer that comes due to the next. */
const run = async <T>(work: Promise<T>): Promise<T> => {
  const state = { settled: false }
  work.then(
    () => (state.settled = true),
    () => (state.settled = true),
  )
  for (let step = 0; !state.settled; step += 1) {
    if (step >= 10_000) throw new Error("The work never ended.")
    // eslint-disable-next-line no-await-in-loop -- One timer at a time.
    await vi.advanceTimersToNextTimerAsync()
  }
  return work
}
const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/**
 * A terminal as the typist sees it: a screen that a paste changes as `takes` says, and the
 * input hold an entry takes.
 */
const terminal = (
  options: {
    takes?: "box" | "nothing" | "elsewhere"
    /** The pasted line shows only this long after it was written, in milliseconds. */
    landMs?: number
    /** A row far from the box changes by itself this often, in milliseconds. */
    tickMs?: number
    bracketedPaste?: boolean
    foreground?: boolean | undefined
    /** How long a hold lasts before it lapses by itself, in milliseconds. */
    holdMs?: number
    /** How long reading the screen takes, in milliseconds. */
    screenMs?: number
    /** Whether its first screen draws a logo, far from its box, only while the box is empty. */
    logo?: boolean
    /** Its screen can't be read once a paste was written. */
    screenThrowsAfterPaste?: boolean
    /** What the box read says at each look, in turn, the last one standing. */
    inputBox?: readonly boolean[]
    /** The terminal is gone: no screen. */
    gone?: boolean
  } = {},
) => {
  const rows = options.logo
    ? ["header", "", "  logo", "", "", "", "> Ask anything", "", "footer"]
    : ["header", "", "", "", "", "", "> ", "", "footer"]
  const written: string[] = []
  let holds = 0
  let held = false
  // Whether the app's resizes are held, until the hold settles.
  let sizes = false
  let resizedAt = 0
  let tick = 0
  let boxReads = 0
  const timers = [
    options.tickMs === undefined
      ? undefined
      : setInterval(() => {
          tick += 1
          rows[1] = `uptime ${tick}`
        }, options.tickMs),
  ]
  const target = {
    type: (data: string) => {
      written.push(data)
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      const pasted = /^\x1b\[200~(.*)\x1b\[201~$/.exec(data)?.[1]
      if (pasted && options.takes !== "nothing") {
        if (options.landMs) setTimeout(() => (rows[6] = `> ${pasted}`), options.landMs)
        else rows[6] = `> ${pasted}`
      }
      if (pasted && options.takes === "elsewhere") rows[0] = "popup closed"
      if (pasted && options.logo) rows[2] = ""
      return true
    },
    screen: async () => {
      if (options.gone) return undefined
      if (options.screenThrowsAfterPaste && written.length > 0) throw new Error("no screen")
      const text = screen({ rows: [...rows], bracketedPaste: options.bracketedPaste ?? true })
      if (options.screenMs) await new Promise((resolve) => setTimeout(resolve, options.screenMs))
      return text
    },
    get resizedAt() {
      return resizedAt
    },
    holdsForeground: () => Promise.resolve("foreground" in options ? options.foreground : true),
  }
  const entry: InputEntry = {
    hold: () => {
      holds += 1
      held = true
      sizes = true
      const lapse =
        options.holdMs === undefined ? undefined : setTimeout(() => (held = false), options.holdMs)
      const release = () => {
        clearTimeout(lapse)
        held = false
      }
      return {
        release,
        settle: () => {
          release()
          sizes = false
        },
        settleAfter: () => {},
        holding: () => held,
        discard: () => {},
      }
    },
  }
  const reads = options.inputBox
  const inputBox = () => (reads ? reads[((boxReads += 1) - 1) % reads.length]! : true)
  return {
    target,
    entry,
    inputBox,
    rows,
    written,
    state: () => ({ holds, held, sizes }),
    resize: () => (resizedAt = Date.now()),
    stop: () => timers.forEach((timer) => clearInterval(timer)),
  }
}

const fast = { calmMs: 30, pollMs: 5, pasteMs: 100, watchMs: 10 } as const
const line = (nonce: string) => `[notice ${nonce}]`
const enters = (written: readonly string[]) => written.filter((data) => data === "\r").length

/** A typist over `fake`, and the delivery of its line with a `start` that says yes. */
const typing = (fake: ReturnType<typeof terminal>, timing: Partial<Timing> = {}) => {
  const typist = createTypist(fake.target, {
    profile: fake.inputBox,
    timing: { ...fast, ...timing },
  })
  const deliver = (
    options: {
      vanish?: () => boolean
      calmSince?: number
      start?: (nonce: string) => boolean
      still?: (nonce: string) => boolean
    } = {},
  ) =>
    run(
      typist.deliver(fake.entry, line, {
        calmSince: 0,
        start: () => true,
        still: () => true,
        ...options,
      }),
    )
  return { typist, deliver }
}

describe("a delivery", () => {
  it("pastes the line as a test, then presses Enter once it landed alone, keeping the resizes held", async () => {
    const fake = terminal()
    const { deliver } = typing(fake)
    const delivered = await deliver()
    expect(delivered).toMatchObject({ entered: true })
    expect(fake.written[0]).toMatch(
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      /^\x1b\[200~\[notice [A-Za-z0-9]{6}\]\x1b\[201~$/,
    )
    expect(enters(fake.written)).toBe(1)
    expect(fake.state()).toEqual({ holds: 1, held: false, sizes: true })
    if (delivered.entered) delivered.settle()
    expect(fake.state().sizes).toBe(false)
  })

  it("holds the person's input for the paste and its caps, and the resizes for theirs", async () => {
    const budgets: unknown[] = []
    const fake = terminal()
    const typist = createTypist(fake.target, { profile: fake.inputBox, timing: fast })
    await run(
      typist.deliver({ hold: (budget) => (budgets.push(budget), fake.entry.hold(budget)) }, line, {
        calmSince: 0,
        start: () => true,
        still: () => true,
      }),
    )
    expect(budgets).toEqual([{ inputMs: 100 + 1_500, sizeMs: sizeCapMs }])
  })

  it("presses nothing when a menu or approval swallows the paste, and lets the resizes go", async () => {
    for (const takes of ["nothing", "elsewhere"] as const) {
      const fake = terminal({ takes })
      // eslint-disable-next-line no-await-in-loop -- One terminal at a time.
      const delivered = await typing(fake).deliver()
      expect(delivered).toMatchObject({
        entered: false,
        started: true,
        reason: "not-landed",
        ours: false,
        counted: true,
      })
      expect(fake.written).toHaveLength(1)
      expect(enters(fake.written)).toBe(0)
      expect(fake.state()).toMatchObject({ held: false, sizes: false })
    }
  })

  it("takes a first screen's logo vanishing as the line lands only where the caller allows it", async () => {
    const allowed = terminal({ logo: true })
    expect(await typing(allowed).deliver({ vanish: () => true })).toMatchObject({ entered: true })
    expect(enters(allowed.written)).toBe(1)
    const refused = terminal({ logo: true })
    expect(await typing(refused).deliver()).toMatchObject({ entered: false, started: true })
    expect(enters(refused.written)).toBe(0)
  })

  it("abandons a delivery whose hold lapsed before its Enter, leaving the line as its own", async () => {
    const fake = terminal({ holdMs: 40, screenMs: 30 })
    const delivered = await typing(fake).deliver()
    expect(delivered).toMatchObject({ entered: false, reason: "not-pressed", ours: true })
    expect(fake.written).toHaveLength(1)
    expect(enters(fake.written)).toBe(0)
    expect(fake.state()).toMatchObject({ held: false, sizes: false })
  })

  it("presses nothing once the caller says it is no longer its delivery", async () => {
    const fake = terminal()
    const delivered = await typing(fake).deliver({ still: () => false })
    expect(delivered).toMatchObject({ entered: false, started: true, ours: false })
    expect(enters(fake.written)).toBe(0)
  })

  it("looks at the box again as it begins, and gives up, uncounted and unpasted, if text came", async () => {
    const fake = terminal({ inputBox: [false] })
    const delivered = await typing(fake).deliver()
    expect(delivered).toMatchObject({
      entered: false,
      started: true,
      reason: "no-input-box",
      ours: false,
      counted: false,
    })
    expect(fake.written).toEqual([])
    expect(fake.state()).toMatchObject({ held: false, sizes: false })
  })

  it("skips the box check where the typist is told to", async () => {
    const fake = terminal({ inputBox: [false] })
    const typist = createTypist(fake.target, {
      profile: fake.inputBox,
      boxCheck: false,
      timing: fast,
    })
    const delivered = await run(
      typist.deliver(fake.entry, line, { calmSince: 0, start: () => true, still: () => true }),
    )
    expect(delivered).toMatchObject({ entered: true })
  })

  it("fails when the terminal goes, counted, without a line of its own", async () => {
    const fake = terminal()
    const delivered = await typing(fake).deliver({
      start: () => {
        // The terminal goes between the watch and the paste.
        Object.assign(fake.target, { screen: () => Promise.resolve(undefined) })
        return true
      },
    })
    expect(delivered).toMatchObject({ entered: false, reason: "gone", ours: false, counted: true })
    expect(fake.written).toEqual([])
  })

  it("lets the resizes go and passes the throw on when reading the screen throws once it is under way", async () => {
    const fake = terminal({ screenThrowsAfterPaste: true })
    await expect(typing(fake).deliver()).rejects.toThrow("no screen")
    expect(fake.state()).toMatchObject({ held: false, sizes: false })
  })

  it("is put off, nothing begun or held, when the screen was resized since the calm began", async () => {
    const resized = terminal()
    resized.resize()
    const put = await typing(resized).deliver({ calmSince: resized.target.resizedAt - 1 })
    expect(put).toEqual({ entered: false, started: false, reason: "resized" })
    expect(resized.written).toEqual([])
    expect(resized.state().holds).toBe(0)
  })

  it("is not begun when the caller's start says no", async () => {
    const fake = terminal()
    const delivered = await typing(fake).deliver({ start: () => false })
    expect(delivered).toEqual({ entered: false, started: false, reason: "declined" })
    expect(fake.written).toEqual([])
    expect(fake.state().holds).toBe(0)
  })

  it("is not begun while a row other than a ticking one changes in the watch", async () => {
    const fake = terminal()
    // A popup opens once, mid-watch: one change is no tick.
    setTimeout(() => (fake.rows[3] = "a popup"), 20)
    const delivered = await typing(fake, { watchMs: 40 }).deliver()
    expect(delivered).toEqual({ entered: false, started: false, reason: "restless" })
    expect(fake.written).toEqual([])
  })

  it("is not begun when the terminal is gone", async () => {
    const delivered = await typing(terminal({ gone: true })).deliver()
    expect(delivered).toEqual({ entered: false, started: false, reason: "restless" })
  })

  it("gives a line the time its platform allows to show, Windows more than elsewhere", async () => {
    expect(pasteMsOn("win32")).toBeGreaterThan(pasteMsOn("linux"))
    // Shown 250 ms after it was written: past 100 ms, within 400.
    const late = terminal({ landMs: 250 })
    expect(await typing(late, { pasteMs: 100 }).deliver()).toMatchObject({ entered: false })
    const slow = terminal({ landMs: 250 })
    expect(await typing(slow, { pasteMs: 400 }).deliver()).toMatchObject({ entered: true })
  })

  describe("on a screen with a row that ticks by itself", () => {
    const ticking = { watchMs: 250, pasteMs: 400 }

    it("still presses Enter: a row far from the box changing is no sign of a popup", async () => {
      const fake = terminal({ tickMs: 60 })
      const delivered = await typing(fake, ticking).deliver()
      fake.stop()
      expect(delivered).toMatchObject({ entered: true })
      expect(enters(fake.written)).toBe(1)
    })

    it("still fails a paste that changed another row far from the box", async () => {
      const fake = terminal({ tickMs: 60, takes: "elsewhere" })
      const delivered = await typing(fake, ticking).deliver()
      fake.stop()
      expect(delivered).toMatchObject({ entered: false, started: true })
      expect(enters(fake.written)).toBe(0)
    })
  })

  it("reports each step to the trace", async () => {
    const lines: string[] = []
    const fake = terminal()
    const typist = createTypist(fake.target, {
      profile: fake.inputBox,
      timing: fast,
      trace: (text) => lines.push(text),
    })
    await run(
      typist.deliver(fake.entry, line, { calmSince: 0, start: () => true, still: () => true }),
    )
    expect(lines).toEqual([
      expect.stringMatching(/^ring [A-Za-z0-9]{6} begins \(ticking rows none\)$/),
      expect.stringMatching(/^ring [A-Za-z0-9]{6}: paste accepted, Enter$/),
    ])
  })
})

describe("a submission", () => {
  it("presses Enter alone, pasting nothing, while the hold and the caller's nonce stand", async () => {
    const fake = terminal()
    const typist = createTypist(fake.target, { profile: fake.inputBox, timing: fast })
    const nonces: string[] = []
    const delivered = await run(
      typist.submit(fake.entry, "k3f9Xz", (nonce) => {
        nonces.push(nonce)
        return true
      }),
    )
    expect(delivered).toMatchObject({ entered: true, nonce: "k3f9Xz" })
    expect(fake.written).toEqual(["\r"])
    expect(nonces).toEqual(["k3f9Xz"])
    expect(fake.state()).toEqual({ holds: 1, held: false, sizes: true })
  })

  it("presses nothing once the nonce is no longer the caller's, and says the line is ours", async () => {
    const fake = terminal()
    const typist = createTypist(fake.target, { profile: fake.inputBox, timing: fast })
    const delivered = await run(typist.submit(fake.entry, "k3f9Xz", () => false))
    expect(delivered).toMatchObject({
      entered: false,
      reason: "not-pressed",
      ours: true,
      counted: true,
    })
    expect(fake.written).toEqual([])
    expect(fake.state()).toMatchObject({ held: false, sizes: false })
  })
})

describe("a look and the gate on it", () => {
  const looking = (fake: ReturnType<typeof terminal>): Typist =>
    createTypist(fake.target, { profile: fake.inputBox, timing: fast })

  it("measures how long the screen has been still, and a change starts it over", async () => {
    const fake = terminal()
    const typist = looking(fake)
    const first = await typist.look()
    expect(first?.calm).toBe(false)
    await sleep(40)
    const second = await typist.look()
    expect(second).toMatchObject({ calm: true })
    expect(second!.calmFor).toBeGreaterThanOrEqual(30)
    expect(second!.calmSince).toBe(first!.at)
    fake.rows[1] = "a clock ticked"
    expect((await typist.look())?.calm).toBe(false)
  })

  it("counts a resize as an end to the calm, as the screen may not have redrawn for it yet", async () => {
    const fake = terminal()
    const typist = looking(fake)
    await typist.look()
    await sleep(40)
    fake.resize()
    const look = await typist.look()
    expect(look?.calm).toBe(false)
    expect(look!.calmSince).toBe(fake.target.resizedAt)
  })

  it("forgets what it saw of a terminal that went", async () => {
    const fake = terminal()
    const typist = looking(fake)
    await typist.look()
    await sleep(40)
    typist.forget()
    expect((await typist.look())?.calm).toBe(false)
  })

  it("sees nothing of a terminal that is gone", async () => {
    expect(await looking(terminal({ gone: true })).look()).toBeUndefined()
  })

  it("opens for a calm screen, bracketed paste on, the program in front and its box showing", async () => {
    const fake = terminal()
    const typist = looking(fake)
    await typist.look()
    await sleep(40)
    const look = (await typist.look())!
    expect(await typist.ready(look)).toBe("open")
  })

  it("opens where the platform can't tell the foreground", async () => {
    const fake = terminal({ foreground: undefined })
    const typist = looking(fake)
    await typist.look()
    await sleep(40)
    expect(await typist.ready((await typist.look())!)).toBe("open")
  })

  it("keeps shut without bracketed paste, off the foreground, or with the caller's veto", async () => {
    const cases = [
      [{ bracketedPaste: false }, undefined, "no-bracketed-paste"],
      [{ foreground: false }, undefined, "not-foreground"],
      [{}, () => true, "vetoed"],
      [{ inputBox: [false] }, undefined, "no-input-box"],
    ] as const
    for (const [options, veto, expected] of cases) {
      const fake = terminal(options)
      const typist = looking(fake)
      // eslint-disable-next-line no-await-in-loop -- One terminal at a time.
      await typist.look()
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(40)
      // eslint-disable-next-line no-await-in-loop -- As above.
      expect(await typist.ready((await typist.look())!, veto)).toBe(expected)
    }
  })

  it("is restless on a screen not calm for the period", async () => {
    const fake = terminal()
    const typist = looking(fake)
    expect(await typist.ready((await typist.look())!)).toBe("restless")
  })

  it("reads the box by a profile, empty and taking a prompt, with no view over it", async () => {
    let text = ""
    let overlay = false
    const profile = {
      read: () => ({ mode: "prompt", text }),
      overlay: () => overlay,
    } as unknown as BoxProfile
    const fake = terminal()
    const typist = createTypist(fake.target, { profile, timing: fast })
    await typist.look()
    await sleep(40)
    const look = (await typist.look())!
    expect(await typist.ready(look)).toBe("open")
    text = "a draft"
    expect(await typist.ready(look)).toBe("no-input-box")
    text = ""
    overlay = true
    expect(await typist.ready(look)).toBe("no-input-box")
  })

  it("tells the gate's verdict to the trace", async () => {
    const lines: string[] = []
    const fake = terminal()
    const typist = createTypist(fake.target, {
      profile: fake.inputBox,
      timing: fast,
      trace: (text) => lines.push(text),
    })
    await typist.look()
    await sleep(40)
    await typist.ready((await typist.look())!, () => true)
    expect(lines).toEqual([
      "gate not-ringable (foreground true, input box true, bracketed paste true)",
    ])
  })
})
