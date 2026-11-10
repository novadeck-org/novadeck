import { context, describe, expect, it } from "../../test"
import { headroom, pace } from "./pacing"

describe("the scoreboard's pace through the request budget", () => {
  const reset = 1_800_000_000

  context("when the budget covers what is needed and the headroom", () => {
    it("fetches everything at once", () => {
      expect(pace(1000, reset, 750)).toEqual({ kind: "fetch", count: 750 })
    })
  })

  context("when the budget covers only part of it", () => {
    it("fetches what leaves the headroom, then asks again", () => {
      expect(pace(500, reset, 750)).toEqual({ kind: "fetch", count: 500 - headroom })
    })
  })

  context("when only the headroom is left", () => {
    it("waits for the budget to be renewed", () => {
      expect(pace(headroom, reset, 10)).toEqual({ kind: "wait", until: reset })
      expect(pace(50, reset, 10)).toEqual({ kind: "wait", until: reset })
    })
  })
})
