import { setTimeout as sleep } from "node:timers/promises"

import { screen } from "@novadeck/harness-core/testing/screens"
import { InputQueue, pasteMsOn, type TypingTarget } from "@novadeck/tui-input"
import type { BoxProfile } from "@novadeck/tui-input/box"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import type { Waits } from "./delivery.js"
import { confirmMs, Doorbell, ringSizeCapMs, type DoorbellHost } from "./doorbell.js"

/**
 * A terminal as the doorbell sees it: a screen that a paste changes as `takes` says,
 * and messaging's ring state.
 */
const terminal = (
  options: {
    takes?: "box" | "nothing" | "elsewhere"
    ringable?: boolean
    /** Idle but Drafting, Unknown or Fresh, not ringable by state: what its screen reads as. */
    stalled?: "empty" | "starting" | Waits
    /** The pasted line shows only this long after it was written, in milliseconds. */
    landMs?: number
    /** The agent's activity says a turn runs. */
    busy?: boolean
    /** Idle with the line a failed ring left in the box, all it holds: its nonce. */
    leftover?: string
    /** A row far from the box changes by itself this often, in milliseconds. */
    tickMs?: number
    /** The screen changes this often, as output streaming, in milliseconds. */
    streamMs?: number
    /** What the box read says at each look, in turn, the last one standing. */
    inputBox?: readonly boolean[]
    bracketedPaste?: boolean
    foreground?: boolean | undefined
    /** How long a hold lasts before it lapses by itself, in milliseconds. */
    holdMs?: number
    /** How long reading the screen takes, in milliseconds. */
    screenMs?: number
    /** When it became Settled, its turn ended, in epoch milliseconds. */
    settledAt?: number
    /** Whether it is Ready, at its first screen, rather than Settled. */
    ready?: boolean
    /** Whether its first screen draws a logo, far from its box, only while the box is empty. */
    logo?: boolean
    /** Its screen can't be read once a ring is under way. */
    screenThrowsWhileRinging?: boolean
    /** A queued prompt bars its screen from being believed this long from the start, in milliseconds. */
    barredMs?: number
    /** Resizes it as the foreground is looked at, once: after the calm, before the ring. */
    resizeAtForeground?: boolean
    /** Its hold's settle never takes effect: only the size cap ends the hold of the resizes. */
    settleLost?: boolean
  } = {},
) => {
  const rows = options.logo
    ? ["header", "", "  logo", "", "", "", "> Ask anything", "", "footer"]
    : ["header", "", "", "", "", "", "> ", "", "footer"]
  const written: string[] = []
  let ringable = options.ringable ?? true
  let ringing: string | undefined
  const failed: string[] = []
  let holds = 0
  let held = false
  // Whether the app's resizes are held, until the hold settles or its size cap lapses.
  let sizes = false
  // This models one hold at a time: the sizes waiting are shared, and applied at its end.
  // The app's sizes that reached the terminal, and one that waits on the hold.
  let applied = 0
  let holdAt: number | undefined
  let waiting = false
  let rings = 0
  let pastedAt: number | undefined
  let resizedAt = 0
  let resizeAtForeground = options.resizeAtForeground ?? false
  let stalled = options.stalled !== undefined
  let barEnd = Date.now() + (options.barredMs ?? 0)
  let reading: "empty" | "starting" | Waits = options.stalled ?? "empty"
  const emptied: number[] = []
  const blocks: (Waits | null)[] = []
  let leftover = options.leftover
  const oursReported: boolean[] = []
  const ringLeftovers: string[] = []
  let tick = 0
  const ticker =
    options.tickMs === undefined
      ? undefined
      : setInterval(() => {
          tick += 1
          rows[1] = `uptime ${tick}`
        }, options.tickMs)
  let stamp = 1
  let screens = 0
  // When each screen was read.
  const screensAt: number[] = []
  let boxReads = 0
  const emptiedAt: number[] = []
  const streamer =
    options.streamMs === undefined
      ? undefined
      : setInterval(() => (rows[2] = `output ${Math.random()}`), options.streamMs)
  const profile = options.inputBox && {
    read: () =>
      options.inputBox![((boxReads += 1) - 1) % options.inputBox!.length]!
        ? { mode: "prompt", text: "" }
        : undefined,
    overlay: () => false,
  }
  const host: DoorbellHost = {
    stamp: () => String(stamp),
    // Without an `inputBox` sequence there is no profile option: the gate can't tell the box.
    ...(profile && { profile: () => profile as unknown as BoxProfile }),

    leftover: () => leftover,
    ringLeftover: (_, nonce) => {
      ringLeftovers.push(nonce)
      ringing = nonce
      return true
    },
    stalled: () => stalled && Date.now() >= barEnd,
    barred: () => Math.max(0, barEnd - Date.now()),
    reading: () => reading,
    emptied: (_, readAt) => {
      emptied.push(readAt)
      emptiedAt.push(Date.now())
      stalled = false
      ringable = true
    },
    blocked: (_, waits) => {
      if (blocks.at(-1) !== waits) blocks.push(waits)
    },
    ringable: () => ringable && ringing === undefined,
    settledSince: () => options.settledAt,
    ready: () => options.ready ?? false,
    ring: (_, nonce) => {
      if (!ringable || options.busy) return false
      rings += 1
      ringable = false
      ringing = nonce
      return true
    },
    ringing: () => ringing,
    ringFailed: (_, nonce, ours) => {
      oursReported.push(ours === true)
      if (ringing !== nonce) return
      ringing = undefined
      failed.push(nonce)
      // A failed ring leaves the terminal Unknown, idle with its messages waiting.
      stalled = true
    },
    target: () => target,
  }
  const target: TypingTarget = {
    screen: async () => {
      screens += 1
      screensAt.push(Date.now())
      if (options.screenThrowsWhileRinging && ringing !== undefined) throw new Error("no screen")
      const text = screen({ rows: [...rows], bracketedPaste: options.bracketedPaste ?? true })
      if (options.screenMs) await sleep(options.screenMs)
      return text
    },
    holdsForeground: () => {
      if (resizeAtForeground) {
        resizeAtForeground = false
        resizedAt = Date.now()
      }
      return Promise.resolve(options.foreground)
    },
    get resizedAt() {
      return resizedAt
    },
    type: (data) => {
      written.push(data)
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      const pasted = /^\x1b\[200~(.*)\x1b\[201~$/.exec(data)?.[1]
      if (pasted) pastedAt ??= Date.now()
      if (pasted && options.takes !== "nothing") {
        if (options.landMs) setTimeout(() => (rows[6] = `> ${pasted}`), options.landMs)
        else rows[6] = `> ${pasted}`
      }
      if (pasted && options.takes === "elsewhere") rows[0] = "popup closed"
      if (pasted && options.logo) rows[2] = ""
      return true
    },
  }
  const queue = new InputQueue({
    hold: (_, budget) => {
      holds += 1
      holdAt = Date.now()
      held = true
      sizes = true
      // As the terminal's hold: the size cap ends the hold of the resizes, applying the one waiting.
      const finish = () => {
        clearTimeout(sizeCap)
        if (!sizes) return
        sizes = false
        if (waiting) applied += 1
        waiting = false
      }
      const sizeCap = setTimeout(finish, budget.sizeMs)
      sizeCap.unref()
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
          if (!options.settleLost) finish()
        },
        settleAfter: () => {},
        holding: () => held,
        discard: () => {},
      }
    },
  })
  return {
    host: Object.assign(host, { queue }),
    rows,
    written,
    failed,
    emptied,
    blocks,
    ringLeftovers,
    emptiedAt,
    oursReported,
    bump: () => (stamp += 1),
    screens: () => screens,
    screensAt,
    // A queued prompt bars the screen from being believed for this long from now.
    bar: (ms: number) => (barEnd = Date.now() + ms),
    stop: () => {
      clearInterval(ticker)
      clearInterval(streamer)
    },
    // The leftover line is gone, or was never Novadeck's.
    clearLeftover: () => (leftover = undefined),
    // What its screen reads as now, for a stalled terminal.
    read: (next: "empty" | "starting" | Waits) => (reading = next),
    state: () => ({ ringing, holds, held, sizes, rings, pastedAt, resizedAt, applied, holdAt }),
    // The app sends a size: it waits while the resizes are held, else reaches the terminal.
    send: () => {
      if (sizes) waiting = true
      else applied += 1
    },
    // The app resized its window now.
    resize: () => (resizedAt = Date.now()),
    // The ring's prompt arrived: messaging leaves Ringing.
    confirm: () => (ringing = undefined),
  }
}

// Pinned to one platform, so the suite behaves alike on every host (the Windows paths have
// tests of their own, which say so).
const fast = {
  calmMs: 30,
  pollMs: 5,
  pasteMs: 100,
  confirmMs: 100,
  watchMs: 10,
  platform: "linux",
} as const
const enters = (written: readonly string[]) => written.filter((data) => data === "\r").length

describe("a ring's wait for its doorbell prompt", () => {
  it("outlasts a hook's shell starting cold on Windows, and stays brief elsewhere", () => {
    // PowerShell takes most of 15 s to start cold on a busy CI runner.
    expect(confirmMs("win32")).toBeGreaterThan(15_000)
    expect(confirmMs("linux")).toBe(5_000)
  })

  it("holds the app's resizes until the latest Enter's wait is over, from production defaults", () => {
    const cap = (platform: NodeJS.Platform) =>
      ringSizeCapMs(pasteMsOn(platform), confirmMs(platform))
    expect(cap("linux")).toBe(8_000)
    expect(cap("darwin")).toBe(8_000)
    expect(cap("win32")).toBe(30_500)
  })
})

describe("the app's resizes during a ring's wait for its prompt on Windows", () => {
  const win = { calmMs: 30, pollMs: 5, watchMs: 10, platform: "win32" } as const
  /**
   * Runs the fake clock until the ring's Enter is pressed; when it was. The typist's own short
   * sleeps are real, so each step also lets a few real milliseconds pass.
   */
  const pressed = async (doorbell: Doorbell, t: ReturnType<typeof terminal>) => {
    doorbell.changed("t")
    for (let i = 0; i < 200 && enters(t.written) === 0; i += 1)
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      await Promise.all([vi.advanceTimersByTimeAsync(50), sleep(10)])
    expect(enters(t.written)).toBe(1)
    return Date.now()
  }
  const elapsed = (since: number) => Date.now() - since

  it("holds past the old 8 s cap until the prompt confirms, then applies right after", async () => {
    vi.useFakeTimers()
    try {
      const t = terminal()
      const doorbell = new Doorbell(t.host, t.host.queue, win)
      const at = await pressed(doorbell, t)
      await vi.advanceTimersByTimeAsync(10_000 - elapsed(at))
      t.send()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(t.state()).toMatchObject({ sizes: true, applied: 0 })
      t.confirm()
      doorbell.changed("t")
      expect(t.state()).toMatchObject({ sizes: false, applied: 1 })
      doorbell.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies it once confirmMs fails the ring, not before", async () => {
    vi.useFakeTimers()
    try {
      const t = terminal()
      const doorbell = new Doorbell(t.host, t.host.queue, win)
      const at = await pressed(doorbell, t)
      await vi.advanceTimersByTimeAsync(10_000 - elapsed(at))
      t.send()
      await vi.advanceTimersByTimeAsync(confirmMs("win32") - 1_000 - 10_000)
      expect(t.failed).toHaveLength(0)
      expect(t.state()).toMatchObject({ sizes: true, applied: 0 })
      await vi.advanceTimersByTimeAsync(1_000 + 50)
      expect(t.failed).toHaveLength(1)
      expect(t.state()).toMatchObject({ sizes: false, applied: 1 })
      doorbell.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("still holds at the confirmation deadline when the line landed late, as the Enter comes late", async () => {
    vi.useFakeTimers()
    try {
      // The line shows 3.8 s after it was written: the Enter comes long after the hold began.
      const t = terminal({ landMs: 3_800 })
      const doorbell = new Doorbell(t.host, t.host.queue, win)
      const at = await pressed(doorbell, t)
      await vi.advanceTimersByTimeAsync(10_000 - elapsed(at))
      t.send()
      await vi.advanceTimersByTimeAsync(24_500 - 10_000)
      expect(t.state()).toMatchObject({ ringing: expect.any(String), sizes: true, applied: 0 })
      expect(t.failed).toHaveLength(0)
      t.confirm()
      doorbell.changed("t")
      expect(t.state()).toMatchObject({ sizes: false, applied: 1 })
      doorbell.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("releases it at the cap, after the confirmation deadline, when its settle never comes", async () => {
    vi.useFakeTimers()
    try {
      const t = terminal({ settleLost: true })
      const doorbell = new Doorbell(t.host, t.host.queue, win)
      await pressed(doorbell, t)
      t.send()
      const lapse = t.state().holdAt! + 30_500
      // Past confirmMs the ring has failed, but its settle is lost: the cap still holds.
      await vi.advanceTimersByTimeAsync(lapse - 1 - Date.now())
      expect(t.failed).toHaveLength(1)
      expect(t.state()).toMatchObject({ sizes: true, applied: 0 })
      await vi.advanceTimersByTimeAsync(2)
      expect(t.state()).toMatchObject({ sizes: false, applied: 1 })
      doorbell.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the doorbell", () => {
  it("rings only once the entry ahead of it in the terminal's input queue is done, never between its steps", async () => {
    const { host, written } = terminal()
    const doorbell = new Doorbell(host, host.queue, fast)
    // An answer, and the words that follow it, are one entry: the screen is calm, and the
    // ring due, for longer than the pause between them.
    const events: string[] = []
    const ahead = host.queue.run("t", async () => {
      events.push("answer")
      await sleep(150)
      events.push("words")
      await sleep(10)
    })
    doorbell.changed("t")
    await sleep(120)
    expect(written).toEqual([])
    await ahead
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    expect(events).toEqual(["answer", "words"])
    doorbell.close()
  })

  it("rings a calm, ringable terminal: the test paste, then Enter once it landed alone", async () => {
    const { host, written, state, confirm, failed } = terminal()
    const doorbell = new Doorbell(host, host.queue, fast)
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    expect(written[0]).toMatch(
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      /^\x1b\[200~\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\]\x1b\[201~$/,
    )
    expect(state()).toMatchObject({ holds: 1, held: false })
    confirm()
    await sleep(150)
    expect(failed).toEqual([])
    expect(enters(written)).toBe(1)
    doorbell.close()
  })

  it("holds the app's resizes past its Enter until its prompt confirms the ring", async () => {
    const { host, written, state, confirm } = terminal()
    const doorbell = new Doorbell(host, host.queue, { ...fast, confirmMs: 1_000 })
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    // The person's keys go on after the Enter; the app's sizes wait for the prompt.
    expect(state()).toMatchObject({ held: false, sizes: true })
    await sleep(100)
    expect(state().sizes).toBe(true)
    confirm()
    doorbell.changed("t")
    expect(state().sizes).toBe(false)
    doorbell.close()
  })

  it("lets the app's resizes go once a ring fails, pressed or not", async () => {
    const swallowed = terminal({ takes: "nothing" })
    const refused = new Doorbell(swallowed.host, swallowed.host.queue, fast)
    refused.changed("t")
    await vi.waitFor(() => expect(swallowed.failed).toHaveLength(1))
    expect(swallowed.state().sizes).toBe(false)
    refused.close()
    const unconfirmed = terminal()
    const lapsed = new Doorbell(unconfirmed.host, unconfirmed.host.queue, fast)
    lapsed.changed("t")
    await vi.waitFor(() => expect(enters(unconfirmed.written)).toBe(1))
    expect(unconfirmed.state().sizes).toBe(true)
    await vi.waitFor(() => expect(unconfirmed.failed).toHaveLength(1))
    expect(unconfirmed.state().sizes).toBe(false)
    lapsed.close()
  })

  it("fails a ring and lets the resizes go when reading the screen throws once it is under way", async () => {
    const { host, state, failed } = terminal({ screenThrowsWhileRinging: true })
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const doorbell = new Doorbell(host, host.queue, fast)
      doorbell.changed("t")
      await vi.waitFor(() => expect(failed).toHaveLength(1))
      expect(state().ringing).toBeUndefined()
      expect(state().sizes).toBe(false)
      expect(state().held).toBe(false)
      doorbell.close()
    } finally {
      log.mockRestore()
    }
  })

  it("takes a first screen's logo vanishing as the line lands only when the terminal is Ready", async () => {
    const ready = terminal({ logo: true, ready: true })
    const rung = new Doorbell(ready.host, ready.host.queue, fast)
    rung.changed("t")
    await vi.waitFor(() => expect(enters(ready.written)).toBe(1))
    rung.close()
    const settled = terminal({ logo: true })
    const refused = new Doorbell(settled.host, settled.host.queue, fast)
    refused.changed("t")
    await vi.waitFor(() => expect(settled.failed).toHaveLength(1))
    expect(enters(settled.written)).toBe(0)
    refused.close()
  })

  it("waits for its screen to settle after its turn before it looks", async () => {
    const { host, written } = terminal({ settledAt: Date.now() })
    const doorbell = new Doorbell(host, host.queue, { ...fast, settleMs: 300 })
    doorbell.changed("t")
    await sleep(200)
    expect(written).toEqual([])
    await vi.waitFor(() => expect(enters(written)).toBe(1), { timeout: 1_000 })
    doorbell.close()
  })

  it("waits for the screen to be still for its calm period", async () => {
    const { host, rows, written } = terminal()
    const doorbell = new Doorbell(host, host.queue, { ...fast, calmMs: 200 })
    doorbell.changed("t")
    await sleep(100)
    rows[1] = "a clock ticked"
    doorbell.changed("t")
    await sleep(150)
    expect(written).toEqual([])
    await vi.waitFor(() => expect(enters(written)).toBe(1), { timeout: 1_000 })
    doorbell.close()
  })

  it("counts a resize as an end to the calm, as the screen may not have redrawn for it yet", async () => {
    const { host, written, resize } = terminal()
    const doorbell = new Doorbell(host, host.queue, { ...fast, calmMs: 200 })
    doorbell.changed("t")
    await sleep(100)
    resize()
    await sleep(150)
    expect(written).toEqual([])
    await vi.waitFor(() => expect(enters(written)).toBe(1), { timeout: 1_000 })
    doorbell.close()
  })

  it("puts off, untried, a ring whose terminal was resized after its calm, and rings once calm again", async () => {
    const { host, written, failed, state } = terminal({ resizeAtForeground: true })
    const doorbell = new Doorbell(host, host.queue, { ...fast, calmMs: 100 })
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1), { timeout: 1_000 })
    const { rings, pastedAt, resizedAt } = state()
    // One ring, begun only once the screen had been calm again since the resize.
    expect(rings).toBe(1)
    expect(pastedAt! - resizedAt).toBeGreaterThanOrEqual(100)
    expect(written).toHaveLength(2)
    expect(failed).toEqual([])
    doorbell.close()
  })

  it("fails a ring no doorbell prompt confirms, and never presses Enter again", async () => {
    const { host, written, failed } = terminal()
    const doorbell = new Doorbell(host, host.queue, fast)
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(enters(written)).toBe(1)
    // Unknown now: however its screen changes, nothing more is typed.
    doorbell.changed("t")
    await sleep(120)
    expect(written).toHaveLength(2)
    doorbell.close()
  })

  it("keeps its gate shut without bracketed paste, off the foreground, or with nothing to ring", async () => {
    for (const options of [{ bracketedPaste: false }, { foreground: false }, { ringable: false }]) {
      const { host, written } = terminal(options)
      const doorbell = new Doorbell(host, host.queue, fast)
      doorbell.changed("t")
      // eslint-disable-next-line no-await-in-loop -- One terminal at a time.
      await sleep(120)
      expect(written).toEqual([])
      doorbell.close()
    }
  })

  it("rings where the platform can't tell the foreground", async () => {
    const { host, written } = terminal({ foreground: undefined })
    const doorbell = new Doorbell(host, host.queue, fast)
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    doorbell.close()
  })
})

describe("the doorbell on an idle terminal its state keeps from ringing", () => {
  const recheck = { ...fast, recheckMs: 20, recheckMaxMs: 80 }

  it("makes it Ready, then rings it, once its box reads empty on a calm screen", async () => {
    const { host, written, emptied, blocks } = terminal({ ringable: false, stalled: "empty" })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    expect(emptied).toHaveLength(1)
    expect(blocks).toEqual([null])
    doorbell.close()
  })

  it("never types over a draft: it says why, and rings once the box is emptied", async () => {
    const { host, written, emptied, blocks, read } = terminal({
      ringable: false,
      stalled: "draft",
    })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await sleep(250)
    expect(written).toEqual([])
    expect(emptied).toEqual([])
    expect(blocks).toEqual(["draft"])
    read("empty")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    expect(blocks).toEqual(["draft", null])
    doorbell.close()
  })

  it.each(["dialog", "asking"] as const)("presses nothing while a %s is up", async (waits) => {
    const { host, written, emptied, blocks } = terminal({ ringable: false, stalled: waits })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await sleep(200)
    expect(written).toEqual([])
    expect(emptied).toEqual([])
    expect(blocks).toEqual([waits])
    doorbell.close()
  })

  it("looks again with growing waits while it cannot ring, not on every tick", async () => {
    const { host } = terminal({ ringable: false, stalled: "draft" })
    let reads = 0
    const counted = { ...host, reading: () => ((reads += 1), "draft" as const) }
    const doorbell = new Doorbell(counted, host.queue, {
      ...recheck,
      recheckMs: 40,
      recheckMaxMs: 160,
    })
    doorbell.changed("t")
    await sleep(600)
    // Waits of 40, 80, 160, 160 ms after the calm's 30 ms: a handful of looks, not dozens.
    expect(reads).toBeGreaterThan(2)
    expect(reads).toBeLessThan(9)
    doorbell.close()
  })

  it("rings again after a failed ring leaves it Unknown, with longer waits each time", async () => {
    const { host, written, failed, emptied, emptiedAt } = terminal({ takes: "nothing" })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed).toHaveLength(1), { interval: 1 })
    const failedAt = Date.now()
    // Unknown, idle, its box empty again: Ready and rung once more, not stranded, but not
    // at once.
    await vi.waitFor(() => expect(failed.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 })
    expect(emptied).toHaveLength(1)
    // The wait is 40 ms; Windows' timers run in 15.6 ms ticks, so a little less may pass.
    expect(emptiedAt[0]! - failedAt).toBeGreaterThanOrEqual(20)
    expect(enters(written)).toBe(0)
    doorbell.close()
  })
})

describe("the doorbell on the line a failed ring left in the box", () => {
  const recheck = { ...fast, recheckMs: 20, recheckMaxMs: 80 }

  it("submits it with Enter alone, pasting nothing, once the wait is over", async () => {
    const { host, written, ringLeftovers } = terminal({
      ringable: false,
      stalled: "draft",
      leftover: "k3f9Xz",
    })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    expect(ringLeftovers).toEqual(["k3f9Xz"])
    expect(written).toEqual(["\r"])
    doorbell.close()
  })

  it("leaves it alone once it is not Novadeck's: the person's key made it their draft", async () => {
    const { host, written, ringLeftovers, clearLeftover } = terminal({
      ringable: false,
      stalled: "draft",
      leftover: "k3f9Xz",
    })
    clearLeftover()
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await sleep(250)
    expect(written).toEqual([])
    expect(ringLeftovers).toEqual([])
    doorbell.close()
  })
})

describe("the doorbell's care with a terminal it looks at", () => {
  const recheck = { ...fast, recheckMs: 20, recheckMaxMs: 40 }

  it("counts the calm from when it began, so a key typed meanwhile is not forgotten", async () => {
    const { host, emptied, emptiedAt, stop } = terminal({ ringable: false, stalled: "empty" })
    const doorbell = new Doorbell(host, host.queue, { ...recheck, calmMs: 60 })
    const began = Date.now()
    doorbell.changed("t")
    await vi.waitFor(() => expect(emptied).toHaveLength(1))
    // The read it rests on began at or before the calm's start, a calm long before the look.
    expect(emptiedAt[0]! - emptied[0]!).toBeGreaterThanOrEqual(50)
    expect(emptied[0]!).toBeGreaterThanOrEqual(began - 5)
    stop()
    doorbell.close()
  })

  it("gives up after three failed rings, until something happens in the terminal", async () => {
    const { host, failed, blocks, bump, stop } = terminal({ takes: "nothing" })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed).toHaveLength(3), { timeout: 3_000 })
    await sleep(300)
    expect(failed).toHaveLength(3)
    expect(blocks.at(-1)).toBe("failed")
    // A root turn event or a key of the person's: it tries again.
    bump()
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed.length).toBeGreaterThan(3), { timeout: 3_000 })
    stop()
    doorbell.close()
  })

  it("does not count a ring given up before it pasted anything", async () => {
    const { host, failed, blocks, stop } = terminal({ inputBox: [true, true, false] })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed.length).toBeGreaterThanOrEqual(3), { timeout: 3_000 })
    expect(blocks).not.toContain("failed")
    stop()
    doorbell.close()
  })

  it("looks just after a queued prompt's bar, not when the old wait would end", async () => {
    const { host, emptied, emptiedAt, screens, bar, read, stop } = terminal({
      ringable: false,
      stalled: "dialog",
    })
    const doorbell = new Doorbell(host, host.queue, {
      ...recheck,
      calmMs: 30,
      recheckMs: 20,
      recheckMaxMs: 640,
    })
    doorbell.changed("t")
    // The wait doubles to its cap; a look just made leaves the longest one ahead.
    await sleep(1_000)
    const looks = screens()
    await vi.waitFor(() => expect(screens()).toBeGreaterThan(looks), { timeout: 1_500 })
    const began = Date.now()
    bar(100)
    read("empty")
    doorbell.changed("t")
    await vi.waitFor(() => expect(emptied).toHaveLength(1), { timeout: 1_500 })
    expect(emptiedAt[0]! - began).toBeGreaterThanOrEqual(100)
    expect(emptiedAt[0]! - began).toBeLessThan(400)
    stop()
    doorbell.close()
  })

  it("starts the backing off over at a key of the person's, though the screen lags it", async () => {
    const { host, rows, emptied, emptiedAt, bump, read, stop } = terminal({
      ringable: false,
      stalled: "dialog",
    })
    const doorbell = new Doorbell(host, host.queue, {
      ...recheck,
      calmMs: 30,
      recheckMs: 20,
      recheckMaxMs: 640,
    })
    doorbell.changed("t")
    await sleep(1_500)
    // Esc closes the dialog: the key is known at once, its redraw a few ms later.
    const keyAt = Date.now()
    bump()
    doorbell.changed("t")
    await sleep(3)
    rows[1] = "dialog closed"
    read("empty")
    const redrawing = setInterval(() => doorbell.changed("t"), 10)
    await vi.waitFor(() => expect(emptied).toHaveLength(1), { timeout: 2_000 })
    clearInterval(redrawing)
    expect(emptiedAt[0]! - keyAt).toBeLessThan(300)
    stop()
    doorbell.close()
  })

  it("keeps backing off a stalled terminal whose redraws change nothing", async () => {
    const { host, screens, bump, stop } = terminal({ ringable: false, stalled: "draft" })
    const doorbell = new Doorbell(host, host.queue, {
      ...recheck,
      calmMs: 30,
      recheckMs: 40,
      recheckMaxMs: 160,
    })
    const redrawing = setInterval(() => doorbell.changed("t"), 5)
    await sleep(700)
    clearInterval(redrawing)
    // Looks at 0, ~40, ~120, ~280, ~440, ~600 ms; a look every calm window would be ~20.
    expect(screens()).toBeLessThanOrEqual(8)
    // A key of the person's ends the wait.
    const before = screens()
    bump()
    doorbell.changed("t")
    await vi.waitFor(() => expect(screens()).toBeGreaterThan(before), { timeout: 200 })
    stop()
    doorbell.close()
  })

  it("does not read the screen of a stalled terminal while output streams", async () => {
    const { host, screens, stop } = terminal({ ringable: false, stalled: "draft", streamMs: 5 })
    const doorbell = new Doorbell(host, host.queue, { ...recheck, calmMs: 50 })
    // The screen's changes reach it as they come.
    const changing = setInterval(() => doorbell.changed("t"), 5)
    await sleep(200)
    clearInterval(changing)
    expect(screens()).toBeLessThanOrEqual(5)
    stop()
    doorbell.close()
  })
})

describe("the doorbell's word on the line a failed ring left", () => {
  it("calls it Novadeck's only where the paste check accepted it", async () => {
    const swallowed = terminal({ takes: "nothing" })
    const one = new Doorbell(swallowed.host, swallowed.host.queue, fast)
    one.changed("t")
    await vi.waitFor(() => expect(swallowed.failed).toHaveLength(1))
    expect(swallowed.oursReported[0]).toBe(false)
    one.close()
    swallowed.stop()
    // Accepted, then its hold lapsed before Enter: the line is alone in the box.
    const lapsed = terminal({ holdMs: 1 })
    const two = new Doorbell(lapsed.host, lapsed.host.queue, fast)
    two.changed("t")
    await vi.waitFor(() => expect(lapsed.failed.length).toBeGreaterThan(0))
    expect(lapsed.oursReported[0]).toBe(true)
    two.close()
    lapsed.stop()
  })
})

describe("the doorbell's word on every refusal and look", () => {
  const recheck = { ...fast, recheckMs: 20, recheckMaxMs: 40 }

  it("says the terminal is away when the agent does not hold it, and looks again", async () => {
    const { host, written, blocks, stop } = terminal({ foreground: false })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(blocks).toContain("away"))
    expect(written).toEqual([])
    stop()
    doorbell.close()
  })

  it("says why no box reads, as the screen shows, when the gate finds none", async () => {
    const { host, written, blocks, stop } = terminal({
      inputBox: [false],
      stalled: "draft",
      ringable: true,
    })
    // Ringable by state, its gate refuses: the reading names the draft.
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(blocks).toContain("draft"))
    expect(written).toEqual([])
    stop()
    doorbell.close()
  })

  it("does not submit a leftover line while the agent does not hold the terminal", async () => {
    const { host, written, ringLeftovers, blocks, stop } = terminal({
      ringable: false,
      stalled: "draft",
      leftover: "k3f9Xz",
      foreground: false,
    })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(blocks).toContain("away"))
    expect(written).toEqual([])
    expect(ringLeftovers).toEqual([])
    stop()
    doorbell.close()
  })

  it("does not submit a leftover line while a request waits on the person", async () => {
    const { host, written, ringLeftovers, blocks, stop } = terminal({
      ringable: false,
      stalled: "asking",
      leftover: "k3f9Xz",
    })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await vi.waitFor(() => expect(blocks).toContain("asking"))
    expect(written).toEqual([])
    expect(ringLeftovers).toEqual([])
    stop()
    doorbell.close()
  })

  it("pastes nothing when the ring is refused as the agent's activity says a turn runs", async () => {
    const { host, written, stop } = terminal({ busy: true })
    const doorbell = new Doorbell(host, host.queue, recheck)
    doorbell.changed("t")
    await sleep(250)
    expect(written).toEqual([])
    stop()
    doorbell.close()
  })

  it("says a new session with no box waits for the person once it has shown none a while", async () => {
    const { host, blocks, stop } = terminal({ ringable: false, stalled: "starting" })
    const doorbell = new Doorbell(host, host.queue, { ...recheck, startMs: 80 })
    doorbell.changed("t")
    await sleep(60)
    expect(blocks).not.toContain("dialog")
    await vi.waitFor(() => expect(blocks).toContain("dialog"))
    stop()
    doorbell.close()
  })

  it("looks less often at a screen that keeps changing, up to its cap", async () => {
    // On a fake clock: a loaded machine runs real timers late. This path never rings, so it
    // never reaches the doorbell's sleep, which the fake clock doesn't cover.
    vi.useFakeTimers()
    try {
      const { host, screens, screensAt, stop } = terminal({
        ringable: false,
        stalled: "draft",
        tickMs: 40,
      })
      const doorbell = new Doorbell(host, host.queue, {
        ...recheck,
        calmMs: 100,
        recheckMs: 40,
        recheckMaxMs: 160,
      })
      const changing = setInterval(() => doorbell.changed("t"), 20)
      await vi.advanceTimersByTimeAsync(700)
      clearInterval(changing)
      // The calm window's 100 ms holds the first rechecks (40, 80), then the cap's 160 does.
      expect(screens()).toBe(5)
      expect(screensAt.slice(1).map((at, i) => at - screensAt[i]!)).toEqual([100, 100, 160, 160])
      stop()
      doorbell.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the doorbell on a slow runner, and on a console that keeps redrawing", () => {
  const recheck = { ...fast, recheckMs: 20, recheckMaxMs: 40 }

  it("gives a line more time to show on Windows than elsewhere, before failing the ring", async () => {
    // Shown 250 ms after it was written: past the default elsewhere (here 100 ms), within Windows'.
    const slowWindows = terminal({ landMs: 250 })
    const win = new Doorbell(slowWindows.host, slowWindows.host.queue, {
      calmMs: 30,
      pollMs: 5,
      confirmMs: 100,
      watchMs: 10,
      platform: "win32",
    })
    win.changed("t")
    await vi.waitFor(() => expect(enters(slowWindows.written)).toBe(1), { timeout: 5_000 })
    win.close()
    slowWindows.stop()
  })

  it("still looks at a stalled terminal whose console redraws more often than a calm window", async () => {
    const { host, blocks, stop } = terminal({ ringable: false, stalled: "draft" })
    const doorbell = new Doorbell(host, host.queue, { ...recheck, calmMs: 100 })
    // Told of a change every 10 ms, though its text never changes.
    const redraws = setInterval(() => doorbell.changed("t"), 10)
    await vi.waitFor(() => expect(blocks).toContain("draft"), { timeout: 3_000 })
    clearInterval(redraws)
    stop()
    doorbell.close()
  })
})

describe("the doorbell's promise: it always rings, and never types over a real draft", () => {
  it("rings an idle box, and never pastes once content keys made a draft", async () => {
    const idle = terminal()
    const rung = new Doorbell(idle.host, idle.host.queue, fast)
    rung.changed("t")
    await vi.waitFor(() => expect(enters(idle.written)).toBe(1))
    rung.close()

    // The scheduler's half: messaging knows a key made a draft, so the terminal is not
    // ringable, and the box's text is never rung over.
    const known = terminal({ ringable: false, stalled: "draft" })
    const waiting = new Doorbell(known.host, known.host.queue, { ...fast, recheckMs: 20 })
    waiting.changed("t")
    await sleep(250)
    expect(known.written).toEqual([])
    waiting.close()

    // The typist's half: the terminal is ringable, but text came into the box after the
    // calm, which the typist finds as the ring begins: nothing is pasted.
    const late = terminal({ inputBox: [true, true, false] })
    const caught = new Doorbell(late.host, late.host.queue, { ...fast, recheckMs: 20 })
    caught.changed("t")
    await vi.waitFor(() => expect(late.failed.length).toBeGreaterThanOrEqual(1))
    expect(late.written).toEqual([])
    late.stop()
    caught.close()
  })
})
