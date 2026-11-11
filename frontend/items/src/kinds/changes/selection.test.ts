import type { ChangeLayer } from "@novadeck/core/items"
import { describe, expect, it } from "vitest"

import { anchored, idsOf, pick, railOf, selectedOf, selectionName } from "./selection"

const ids = ["uncommitted", "c3", "c2", "c1"]

describe("the layers selected", () => {
  it("are all of them to start with", () => {
    expect([...selectedOf(ids, [])]).toEqual(ids)
    expect(anchored(ids, [])).toBe(false)
  })

  it("is only the row clicked first, which anchors the next click", () => {
    const first = pick(ids, [], "c2")
    expect(first).toEqual(["c2"])
    expect([...selectedOf(ids, first)]).toEqual(["c2"])
    expect(anchored(ids, first)).toBe(true)
  })

  it("is every row from the anchor to the row clicked next, downward", () => {
    const range = pick(ids, ["uncommitted"], "c2")
    expect(selectedOf(ids, range)).toEqual(new Set(["uncommitted", "c3", "c2"]))
    expect(anchored(ids, range)).toBe(false)
  })

  it("is every row from the anchor to the row clicked next, upward", () => {
    expect(selectedOf(ids, pick(ids, ["c1"], "c3"))).toEqual(new Set(["c3", "c2", "c1"]))
  })

  it("starts over from the row clicked after a range", () => {
    const range = pick(ids, ["uncommitted"], "c2")
    expect(pick(ids, range, "c1")).toEqual(["c1"])
    expect(pick(ids, range, "c3")).toEqual(["c3"])
  })

  it("goes back to all, untouched, when the only row selected is clicked", () => {
    expect(pick(ids, ["c2"], "c2")).toEqual([])
  })

  it("forgets a row that is no longer there", () => {
    expect(selectedOf(["c3", "c2"], ["c1"])).toEqual(new Set(["c3", "c2"]))
    expect(selectedOf(["c3", "c2"], ["c3", "c1"])).toEqual(new Set(["c3"]))
    expect(pick(["c3", "c2"], ["c1"], "c2")).toEqual(["c2"])
    expect(pick(ids, ["c1"], "nope")).toEqual(["c1"])
  })

  it("is all of them when the change has one layer, whichever is clicked", () => {
    expect(selectedOf(["uncommitted"], pick(["uncommitted"], [], "uncommitted"))).toEqual(
      new Set(["uncommitted"]),
    )
  })

  it("lists the ids of the layers in their order", () => {
    expect(idsOf([{ id: "a" }, { id: "b" }] as ChangeLayer[])).toEqual(["a", "b"])
  })
})

describe("the rail beside the layers", () => {
  it("is one rail across rows that are all selected, ending where it starts and ends", () => {
    expect(railOf(ids, new Set(ids))).toEqual([
      { on: true, start: true, end: false },
      { on: true, start: false, end: false },
      { on: true, start: false, end: false },
      { on: true, start: false, end: true },
    ])
  })

  it("is one unbroken rail on a range", () => {
    expect(
      railOf(ids, new Set(["c3", "c2"])).map(({ on, start, end }) => [on, start, end]),
    ).toEqual([
      [false, false, false],
      [true, true, false],
      [true, false, true],
      [false, false, false],
    ])
  })

  it("is one short rail on a row alone", () => {
    expect(railOf(ids, new Set(["c3"])).map(({ on, start, end }) => [on, start, end])).toEqual([
      [false, false, false],
      [true, true, true],
      [false, false, false],
      [false, false, false],
    ])
  })
})

describe("what the files below are of", () => {
  const layers = [
    { id: "uncommitted", kind: "uncommitted" },
    { id: "abcdef0123", kind: "commit" },
    { id: "1234567890", kind: "commit" },
  ] as ChangeLayer[]

  it("names everything, the one layer, or how many of how many", () => {
    expect(selectionName(layers, new Set(["uncommitted", "abcdef0123", "1234567890"]))).toBe(
      "everything",
    )
    expect(selectionName(layers, new Set(["uncommitted"]))).toBe("uncommitted")
    expect(selectionName(layers, new Set(["abcdef0123"]))).toBe("abcdef0")
    expect(selectionName(layers, new Set(["uncommitted", "1234567890"]))).toBe("2 of 3")
  })
})
