import { context, describe, expect, it } from "../test"
import {
  autoRetryDelay,
  bootFill,
  bootLine,
  failureDetails,
  failureOf,
  retryCountdown,
} from "./boot"

const attaching = (attached: number, total: number, done = false) =>
  ({ phase: "attaching", progress: { attached, total, done } }) as const

describe("boot splash status", () => {
  context("while reaching the runner", () => {
    it("says the deck is powering up", () => {
      expect(bootLine({ phase: "connecting" })).toBe("Powering the deck…")
      expect(bootFill({ phase: "connecting" })).toBeGreaterThan(0)
    })
  })

  context("while the workspace loads", () => {
    it("says it is jacking in", () => {
      expect(bootLine({ phase: "loading" })).toBe("Jacking in…")
      expect(bootFill({ phase: "loading" })).toBeGreaterThan(bootFill({ phase: "connecting" }))
    })
  })

  context("while terminals attach", () => {
    it("counts the real attaches", () => {
      expect(bootLine(attaching(2, 5))).toBe("Attaching terminals 2 of 5")
    })

    it("fills the hairline in step", () => {
      expect(bootFill(attaching(0, 4))).toBe(0.3)
      expect(bootFill(attaching(2, 4))).toBeCloseTo(0.65)
      expect(bootFill(attaching(4, 4))).toBe(1)
    })

    it("skips the count when there is nothing to attach", () => {
      expect(bootLine(attaching(0, 0))).toBe("Jacking in…")
    })
  })

  context("once ready", () => {
    it("says the deck is online with a full hairline", () => {
      expect(bootLine({ phase: "online" })).toBe("Deck online")
      expect(bootFill({ phase: "online" })).toBe(1)
    })
  })
})

describe("boot failures", () => {
  const transient = { kind: "transient", message: "m", code: "DISCONNECTED", detail: "d" } as const

  it("retries a transient failure after 2, 4 and 8 s, then stops", () => {
    expect([1, 2, 3, 4].map((failures) => autoRetryDelay(transient, failures))).toEqual([
      2_000,
      4_000,
      8_000,
      undefined,
    ])
  })

  it("never retries other failures on its own", () => {
    for (const kind of ["incompatible", "unauthorized", "unknown"] as const)
      expect(autoRetryDelay({ ...transient, kind }, 1)).toBeUndefined()
  })

  it("counts down in whole seconds", () => {
    expect([3_999, 3_001, 200].map(retryCountdown)).toEqual([
      "Retrying in 4 s…",
      "Retrying in 4 s…",
      "Retrying in 1 s…",
    ])
  })

  it("reads the failure a rejected connect carries, or calls it unknown", () => {
    expect(failureOf(Object.assign(new Error("x"), { failure: transient }))).toBe(transient)
    expect(failureOf(new Error("broke"))).toMatchObject({ kind: "unknown", detail: "broke" })
  })

  it("puts the code, message and attempts in the details", () => {
    expect(failureDetails(transient, 3)).toBe("Code: DISCONNECTED\nMessage: d\nAttempts: 3")
  })
})
