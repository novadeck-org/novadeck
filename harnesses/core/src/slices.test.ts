import type { BoxProfile } from "@novadeck/tui-input/box"
import { describe, expect, it } from "vitest"

import { firstNew, readSlice, type SliceProfile } from "./slices.js"
import { screen } from "./testing/screens.js"

const rule = "─".repeat(20)

const profile = (fields: Partial<SliceProfile> = {}): SliceProfile => ({
  agent: "claude",
  side: () => "above",
  secret: () => false,
  ...fields,
})

/** A box on the row that starts with `> `; none where no row does. */
const box = (fields: Partial<BoxProfile> = {}) =>
  ({
    read: ({ rows }: { rows: readonly string[] }) => {
      const at = rows.findLastIndex((row) => row.startsWith("> "))
      return at < 0 ? undefined : { text: rows[at]!.slice(2).trim(), first: at, last: at }
    },
    ...fields,
  }) as unknown as BoxProfile

// The screen and what was at rest, of one height: a rest of another size says nothing.
const even = (rows: readonly string[], height: number): readonly string[] => [
  ...rows,
  ...Array.from({ length: Math.max(height - rows.length, 0) }, () => ""),
]

const read = (
  drawn: readonly string[],
  resting: readonly string[] | undefined,
  given: {
    readonly box?: BoxProfile
    readonly profile?: SliceProfile
    readonly waiting?: boolean
    readonly unread?: boolean
    readonly under?: number
  } = {},
) => {
  const height = Math.max(drawn.length, resting?.length ?? 0)
  return readSlice({
    screen: screen({ rows: even(drawn, height) }),
    rest: resting && { rows: even(resting, height), columns: 80, under: given.under ?? 1 },
    box: given.box ?? box(),
    profile: given.profile ?? profile(),
    waiting: given.waiting ?? false,
    unread: given.unread ?? false,
  })
}

const atRest = ["one", "", "two", "", rule, "> ", rule, "footer"]

describe("firstNew", () => {
  it("finds the first row the resting rows don't hold", () => {
    expect(firstNew(["one", "", "two", "menu"], atRest)).toBe(3)
  })

  it("follows rows that moved up", () => {
    expect(firstNew(["two", "", "menu"], atRest)).toBe(2)
  })

  it("stops at what was drawn, so a row of it that matches later is not reached", () => {
    expect(firstNew(["one", "new", "two"], atRest)).toBe(1)
  })

  it("counts rows that kept their order only", () => {
    expect(firstNew(["two", "one"], atRest)).toBe(1)
  })

  it("ignores blanks, and the blanks that end rows", () => {
    expect(firstNew(["   ", "one   ", "", "two"], atRest)).toBe(4)
  })
})

describe("readSlice", () => {
  it("rests where the box holds no key", () => {
    expect(read(atRest, undefined)).toEqual({
      bounds: undefined,
      resting: { rows: atRest, columns: 80, under: 1 },
    })
  })

  it("bounds a menu over the box, its rule left out", () => {
    const rows = ["one", "", "two", "menu 1", "menu 2", rule, "> /", rule]
    expect(read(rows, atRest).bounds).toEqual({ reason: "menu", first: 3, last: 4 })
  })

  it("shows no menu above the box with no screen at rest to bound it by", () => {
    expect(read(["one", "menu", rule, "> /"], undefined).bounds).toBeUndefined()
  })

  it("takes no row that changed further up for a menu, as a working line after Esc", () => {
    const rows = ["one", "Working 3s", "", rule, "> /foo", rule]
    expect(read(rows, ["one", "Working 1s", "", rule, "> ", rule]).bounds).toBeUndefined()
  })

  it("shows nothing when nothing was drawn at a key", () => {
    expect(read(["one", "", "two", "", rule, "> /", rule], atRest).bounds).toBeUndefined()
  })

  it("bounds a menu under the box from its rule to the last row drawn", () => {
    const below = profile({ side: () => "below" })
    const rows = ["one", rule, "> /", rule, "menu 1", "", "menu 2", "", ""]
    expect(read(rows, atRest, { profile: below }).bounds).toEqual({
      reason: "menu",
      first: 4,
      last: 6,
    })
  })

  it("takes no footer under the box for a menu, as after Esc kept the text", () => {
    const below = profile({ side: () => "below" })
    expect(
      read(["one", rule, "> /x", rule, "footer"], atRest, { profile: below }).bounds,
    ).toBeUndefined()
    expect(
      read(["one", rule, "> /x", rule, "a", "b"], atRest, { profile: below, under: 2 }).bounds,
    ).toBeUndefined()
  })

  it("bounds a view that took the box's place, rows moved up", () => {
    expect(read(["two", "", "view", "", "esc"], atRest)).toEqual({
      bounds: { reason: "view", first: 2, last: 4 },
      resting: undefined,
    })
  })

  it("takes the whole screen for a view with no rest to go by", () => {
    expect(read(["two", "view"], undefined).bounds).toEqual({ reason: "view", first: 0, last: 1 })
  })

  it("trusts no rest of another size: rows wrap and show anew on it", () => {
    const given = screen({ rows: ["older", "two", "view"], columns: 60 })
    const { bounds } = readSlice({
      screen: given,
      rest: { rows: ["one", "two", "x"], columns: 80, under: 1 },
      box: box(),
      profile: profile(),
      waiting: false,
      unread: false,
    })
    expect(bounds).toEqual({ reason: "view", first: 0, last: 2 })
  })

  it("reads an overlay as a view, wherever the box reads, before any key in it", () => {
    const covered = box({ overlay: () => true })
    expect(read(["one", "> 1. pick $HOME", "esc back"], atRest, { box: covered })).toEqual({
      bounds: { reason: "view", first: 1, last: 2 },
      resting: undefined,
    })
  })

  it("bounds a view under a box that stays, by more rows there than at rest", () => {
    const given = profile({ side: () => "below", viewsUnder: true })
    expect(
      read(["one", rule, "> ", rule, "view", "esc"], atRest, { profile: given }).bounds,
    ).toEqual({ reason: "view", first: 4, last: 5 })
    expect(
      read(["one", rule, "> ", rule, "footer"], atRest, { profile: given }).resting,
    ).toBeDefined()
  })

  it("sets a panel that comes and goes aside when it counts the rows under the box", () => {
    const panel = box({ still: (rows) => rows.filter((row) => row !== "panel") })
    const given = profile({ side: () => "below", viewsUnder: true })
    expect(
      read(["one", rule, "> ", rule, "panel", "footer"], atRest, {
        box: panel,
        profile: given,
      }).resting,
    ).toBeDefined()
  })

  it("leaves a request's dialog to the chat while it reads or is read", () => {
    expect(read(["one", "Allow this?", "1. Yes"], atRest, { waiting: true })).toEqual({
      bounds: undefined,
      resting: undefined,
    })
  })

  it("shows a dialog no adapter read", () => {
    expect(
      read(["one", "Allow this?", "1. Yes"], atRest, { waiting: true, unread: true }).bounds,
    ).toEqual({ reason: "dialog", first: 1, last: 2 })
  })

  it("takes a request at a box that stays as a dialog under it", () => {
    const given = profile({ side: () => "below" })
    expect(
      read(["one", rule, "> ", rule, "Allow?"], atRest, {
        profile: given,
        waiting: true,
        unread: true,
      }).bounds,
    ).toEqual({ reason: "dialog", first: 4, last: 4 })
  })

  it("never rests on a screen a menu or view is on", () => {
    expect(read(["one", "menu", rule, "> /"], atRest).resting).toBeUndefined()
    expect(read(["view"], atRest).resting).toBeUndefined()
  })

  it("shows nothing at a box run off the screen's bottom, and never rests there", () => {
    // Its footer went with its closing rule, so what is under it says nothing of the rest.
    const clipped = box({
      read: ({ rows }) => {
        const at = rows.findLastIndex((row) => row.startsWith("> "))
        return { text: rows[at]!.slice(2), mode: "prompt", first: at, last: at, clipped: true }
      },
    })
    expect(read(["one", "", "two", "", rule, "> words"], atRest, { box: clipped })).toEqual({
      bounds: undefined,
      resting: undefined,
    })
  })
})
