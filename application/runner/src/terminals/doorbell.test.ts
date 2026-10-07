import { setTimeout as sleep } from "node:timers/promises"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { screen } from "../testing/screens.js"
import { Doorbell, type DoorbellHost } from "./doorbell.js"

/**
 * A terminal as the doorbell sees it: a screen that a paste changes as `takes` says,
 * and messaging's ring state.
 */
const terminal = (
  options: {
    takes?: "box" | "nothing" | "elsewhere"
    ringable?: boolean
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
    /** Resizes it as the foreground is looked at, once: after the calm, before the ring. */
    resizeAtForeground?: boolean
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
  // Whether the app's resizes are held, until the hold settles.
  let sizes = false
  let rings = 0
  let pastedAt: number | undefined
  let resizedAt = 0
  let resizeAtForeground = options.resizeAtForeground ?? false
  const host: DoorbellHost = {
    ringable: () => ringable && ringing === undefined,
    settledSince: () => options.settledAt,
    ready: () => options.ready ?? false,
    ring: (_, nonce) => {
      if (!ringable) return false
      rings += 1
      ringable = false
      ringing = nonce
      return true
    },
    ringing: () => ringing,
    ringFailed: (_, nonce) => {
      if (ringing !== nonce) return
      ringing = undefined
      failed.push(nonce)
    },
    screen: async () => {
      const text = screen({ rows: [...rows], bracketedPaste: options.bracketedPaste ?? true })
      if (options.screenMs) await sleep(options.screenMs)
      return text
    },
    foreground: () => {
      if (resizeAtForeground) {
        resizeAtForeground = false
        resizedAt = Date.now()
      }
      return Promise.resolve(options.foreground)
    },
    resizedAt: () => resizedAt,
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
        holding: () => held,
      }
    },
    write: (_, data) => {
      written.push(data)
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      const pasted = /^\x1b\[200~(.*)\x1b\[201~$/.exec(data)?.[1]
      if (pasted) pastedAt ??= Date.now()
      if (pasted && options.takes !== "nothing") rows[6] = `> ${pasted}`
      if (pasted && options.takes === "elsewhere") rows[0] = "popup closed"
      if (pasted && options.logo) rows[2] = ""
      return true
    },
  }
  return {
    host,
    rows,
    written,
    failed,
    state: () => ({ ringing, holds, held, sizes, rings, pastedAt, resizedAt }),
    // The app resized its window now.
    resize: () => (resizedAt = Date.now()),
    // The ring's prompt arrived: messaging leaves Ringing.
    confirm: () => (ringing = undefined),
  }
}

const fast = { calmMs: 30, pollMs: 5, pasteMs: 100, confirmMs: 100 }
const enters = (written: readonly string[]) => written.filter((data) => data === "\r").length

describe("the doorbell", () => {
  it("rings a calm, ringable terminal: the test paste, then Enter once it landed alone", async () => {
    const { host, written, state, confirm, failed } = terminal()
    const doorbell = new Doorbell(host, fast)
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
    const doorbell = new Doorbell(host, { ...fast, confirmMs: 1_000 })
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
    const refused = new Doorbell(swallowed.host, fast)
    refused.changed("t")
    await vi.waitFor(() => expect(swallowed.failed).toHaveLength(1))
    expect(swallowed.state().sizes).toBe(false)
    refused.close()
    const unconfirmed = terminal()
    const lapsed = new Doorbell(unconfirmed.host, fast)
    lapsed.changed("t")
    await vi.waitFor(() => expect(enters(unconfirmed.written)).toBe(1))
    expect(unconfirmed.state().sizes).toBe(true)
    await vi.waitFor(() => expect(unconfirmed.failed).toHaveLength(1))
    expect(unconfirmed.state().sizes).toBe(false)
    lapsed.close()
  })

  it("takes a first screen's logo vanishing as the line lands only when the terminal is Ready", async () => {
    const ready = terminal({ logo: true, ready: true })
    const rung = new Doorbell(ready.host, fast)
    rung.changed("t")
    await vi.waitFor(() => expect(enters(ready.written)).toBe(1))
    rung.close()
    const settled = terminal({ logo: true })
    const refused = new Doorbell(settled.host, fast)
    refused.changed("t")
    await vi.waitFor(() => expect(settled.failed).toHaveLength(1))
    expect(enters(settled.written)).toBe(0)
    refused.close()
  })

  it("abandons a ring whose hold lapsed before its Enter, pressing nothing", async () => {
    const { host, written, failed, state } = terminal({ holdMs: 40, screenMs: 30 })
    const doorbell = new Doorbell(host, fast)
    doorbell.changed("t")
    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(written).toHaveLength(1)
    expect(enters(written)).toBe(0)
    expect(state()).toMatchObject({ ringing: undefined, held: false })
    doorbell.close()
  })

  it("waits for its screen to settle after its turn before it looks", async () => {
    const { host, written } = terminal({ settledAt: Date.now() })
    const doorbell = new Doorbell(host, { ...fast, settleMs: 300 })
    doorbell.changed("t")
    await sleep(200)
    expect(written).toEqual([])
    await vi.waitFor(() => expect(enters(written)).toBe(1), { timeout: 1_000 })
    doorbell.close()
  })

  it("waits for the screen to be still for its calm period", async () => {
    const { host, rows, written } = terminal()
    const doorbell = new Doorbell(host, { ...fast, calmMs: 200 })
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
    const doorbell = new Doorbell(host, { ...fast, calmMs: 200 })
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
    const doorbell = new Doorbell(host, { ...fast, calmMs: 100 })
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

  it("presses nothing when a menu or approval swallows the paste, and fails the ring", async () => {
    for (const takes of ["nothing", "elsewhere"] as const) {
      const { host, written, failed, state } = terminal({ takes })
      const doorbell = new Doorbell(host, fast)
      doorbell.changed("t")
      // eslint-disable-next-line no-await-in-loop -- One terminal at a time.
      await vi.waitFor(() => expect(failed).toHaveLength(1))
      expect(written).toHaveLength(1)
      expect(enters(written)).toBe(0)
      expect(state()).toMatchObject({ ringing: undefined, held: false })
      doorbell.close()
    }
  })

  it("fails a ring no doorbell prompt confirms, and never presses Enter again", async () => {
    const { host, written, failed } = terminal()
    const doorbell = new Doorbell(host, fast)
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
      const doorbell = new Doorbell(host, fast)
      doorbell.changed("t")
      // eslint-disable-next-line no-await-in-loop -- One terminal at a time.
      await sleep(120)
      expect(written).toEqual([])
      doorbell.close()
    }
  })

  it("rings where the platform can't tell the foreground", async () => {
    const { host, written } = terminal({ foreground: undefined })
    const doorbell = new Doorbell(host, fast)
    doorbell.changed("t")
    await vi.waitFor(() => expect(enters(written)).toBe(1))
    doorbell.close()
  })
})
