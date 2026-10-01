import { setTimeout as sleep } from "node:timers/promises"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
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
  } = {},
) => {
  const rows = ["header", "", "", "", "", "", "> ", "", "footer"]
  const written: string[] = []
  let ringable = options.ringable ?? true
  let ringing: string | undefined
  const failed: string[] = []
  let holds = 0
  let held = false
  const host: DoorbellHost = {
    ringable: () => ringable && ringing === undefined,
    settledSince: () => options.settledAt,
    ring: (_, nonce) => {
      if (!ringable) return false
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
      const text = { rows: [...rows], bracketedPaste: options.bracketedPaste ?? true }
      if (options.screenMs) await sleep(options.screenMs)
      return text
    },
    foreground: () => Promise.resolve(options.foreground),
    hold: () => {
      holds += 1
      held = true
      const lapse =
        options.holdMs === undefined ? undefined : setTimeout(() => (held = false), options.holdMs)
      return {
        release: () => {
          clearTimeout(lapse)
          held = false
        },
        holding: () => held,
      }
    },
    write: (_, data) => {
      written.push(data)
      // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
      const pasted = /^\x1b\[200~(.*)\x1b\[201~$/.exec(data)?.[1]
      if (pasted && options.takes !== "nothing") rows[6] = `> ${pasted}`
      if (pasted && options.takes === "elsewhere") rows[0] = "popup closed"
      return true
    },
  }
  return {
    host,
    rows,
    written,
    failed,
    state: () => ({ ringing, holds, held }),
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
      /^\x1b\[200~\[NovaDeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\]\x1b\[201~$/,
    )
    expect(state()).toMatchObject({ holds: 1, held: false })
    confirm()
    await sleep(150)
    expect(failed).toEqual([])
    expect(enters(written)).toBe(1)
    doorbell.close()
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
