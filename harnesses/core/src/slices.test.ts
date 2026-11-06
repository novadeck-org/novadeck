import type { BoxProfile } from "@novadeck/tui-input/box"
import { describe, expect, it } from "vitest"

import { firstNew, opensMenu, readSlice, type SliceProfile } from "./slices.js"
import { screen } from "./testing/screens.js"

const rule = "─".repeat(20)

const profile = (fields: Partial<SliceProfile> = {}): SliceProfile => ({
  leading: ["/"],
  words: ["@"],
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

const read = (
  rows: readonly string[],
  rest: readonly string[] | undefined,
  given: {
    readonly box?: BoxProfile
    readonly profile?: SliceProfile
    readonly waiting?: boolean
    readonly unread?: boolean
  } = {},
) =>
  readSlice({
    screen: screen({ rows }),
    rest: rest && { rows: rest },
    box: given.box ?? box(),
    profile: given.profile ?? profile(),
    waiting: given.waiting ?? false,
    unread: given.unread ?? false,
  })

const resting = ["one", "", "two", "", rule, "> ", rule, "footer"]

describe("firstNew", () => {
  it("finds the first row the resting rows don't hold", () => {
    expect(firstNew(["one", "", "two", "menu"], resting)).toBe(3)
  })

  it("follows rows that moved up", () => {
    expect(firstNew(["two", "", "menu"], resting)).toBe(2)
  })

  it("stops at what was drawn, so a row of it that matches later is not reached", () => {
    expect(firstNew(["one", "new", "two"], resting)).toBe(1)
  })

  it("counts rows that kept their order only", () => {
    expect(firstNew(["two", "one"], resting)).toBe(1)
  })

  it("ignores blanks, and the blanks that end rows", () => {
    expect(firstNew(["   ", "one   ", "", "two"], resting)).toBe(4)
  })
})

describe("opensMenu", () => {
  it("reads a leading key only at the start, a word's key at the last word", () => {
    const given = profile({ words: ["@", "$"] })
    expect(opensMenu("/model", given)).toBe(true)
    expect(opensMenu("see /model", given)).toBe(false)
    expect(opensMenu("@src", given)).toBe(true)
    expect(opensMenu("look at $sk", given)).toBe(true)
    expect(opensMenu("user@host now", given)).toBe(false)
    expect(opensMenu("", given)).toBe(false)
  })
})

describe("readSlice", () => {
  it("rests where the box holds no key", () => {
    expect(read(resting, undefined)).toEqual({ bounds: undefined, resting: true })
  })

  it("bounds a menu over the box, its rule left out", () => {
    const rows = ["one", "", "two", "menu 1", "menu 2", "> /", rule, "footer"]
    expect(read(rows.slice(0, 5).concat(rule, "> /", rule), resting).bounds).toEqual({
      reason: "menu",
      first: 3,
      last: 4,
    })
  })

  it("shows no menu above the box with no screen at rest to bound it by", () => {
    expect(read(["one", "menu", "> /"], undefined).bounds).toBeUndefined()
  })

  it("bounds a menu under the box from its rule to the last row drawn", () => {
    const below = profile({ side: () => "below" })
    const rows = ["one", rule, "> /", rule, "menu 1", "", "menu 2", "", ""]
    expect(read(rows, resting, { profile: below }).bounds).toEqual({
      reason: "menu",
      first: 4,
      last: 6,
    })
  })

  it("shows nothing when nothing was drawn at a key", () => {
    expect(read(["one", "", "two", "> /", rule], resting).bounds).toBeUndefined()
  })

  it("bounds a view that took the box's place, rows moved up", () => {
    expect(read(["two", "", "view", "", "esc"], resting)).toEqual({
      bounds: { reason: "view", first: 2, last: 4 },
      resting: false,
    })
  })

  it("takes the whole screen for a view with no rest to go by", () => {
    expect(read(["two", "view"], undefined).bounds).toEqual({ reason: "view", first: 0, last: 1 })
  })

  it("reads an overlay as a view, wherever the box reads", () => {
    const covered = box({ overlay: () => true })
    expect(read(["one", "history", "> "], resting, { box: covered }).bounds?.reason).toBe("view")
  })

  it("asks the harness of a view its box still reads through", () => {
    const given = profile({ view: () => true })
    expect(read(["one", "> 1. pick", "esc back"], resting, { profile: given })).toEqual({
      bounds: { reason: "view", first: 1, last: 2 },
      resting: false,
    })
  })

  it("bounds a view under a box that stays", () => {
    const given = profile({ side: () => "below", view: () => true })
    expect(
      read(["one", rule, "> ", rule, "view", "esc"], resting, { profile: given }).bounds,
    ).toEqual({ reason: "view", first: 4, last: 5 })
  })

  it("leaves a request's dialog to the chat while it reads or is read", () => {
    const rows = ["one", "Allow this?", "1. Yes"]
    expect(read(rows, resting, { waiting: true })).toEqual({ bounds: undefined, resting: false })
  })

  it("shows a dialog no adapter read", () => {
    expect(
      read(["one", "Allow this?", "1. Yes"], resting, { waiting: true, unread: true }).bounds,
    ).toEqual({ reason: "dialog", first: 1, last: 2 })
  })

  it("takes a request at a box that stays as a dialog under it", () => {
    const given = profile({ side: () => "below" })
    const rows = ["one", rule, "> ", rule, "Allow?"]
    expect(read(rows, resting, { profile: given, waiting: true, unread: true }).bounds).toEqual({
      reason: "dialog",
      first: 4,
      last: 4,
    })
  })

  it("never rests on a screen a menu or view is on", () => {
    expect(read(["one", "menu", rule, "> /"], resting).resting).toBe(false)
    expect(read(["view"], resting).resting).toBe(false)
  })
})
