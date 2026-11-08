import { describe, expect, it } from "vitest"

import {
  desktopBadgeOf,
  parseUpdateOffer,
  parseWhatsNew,
  rendererPoolOf,
  webglContextsOf,
} from "./bridge.js"

describe("a WebGL context limit", () => {
  it.each([3, 16, 64, 1024])("is %s, a whole number in range", (value) => {
    expect(webglContextsOf(value)).toBe(value)
  })

  it.each([
    ["too few", 2],
    ["too many", 1025],
    ["a fraction", 62.5],
    ["not finite", Number.NaN],
    ["text", "64"],
    ["nothing", undefined],
  ])("is nothing when %s", (_name, value) => {
    expect(webglContextsOf(value)).toBeUndefined()
  })
})

describe("a renderer pool report", () => {
  const counts = { waits: 2, steals: 1, swaps: 9, lost: 0, failed: 0, resizes: 3, onDom: 1 }

  it("is the counts, whole numbers, and nothing else", () => {
    expect(rendererPoolOf({ ...counts, extra: 5 })).toEqual(counts)
  })

  it.each([
    ["a fraction", { ...counts, waits: 1.5 }],
    ["NaN", { ...counts, waits: Number.NaN }],
    ["Infinity", { ...counts, swaps: Infinity }],
    ["a count past the safe integers", { ...counts, swaps: Number.MAX_SAFE_INTEGER + 2 }],
    ["a negative count", { ...counts, lost: -1 }],
    ["a count as text", { ...counts, lost: "1" }],
    ["a missing count", { waits: 1 }],
    ["an array", [1, 2, 3]],
    ["null", null],
    ["text", "waits"],
  ])("is dropped for %s", (_name, value) => {
    expect(rendererPoolOf(value)).toBeUndefined()
  })
})

describe("an update offer from the app", () => {
  it.each([
    { kind: "downloading", version: "1.2.3", percent: 40 },
    { kind: "available", version: "1.2.3-beta.4", allow: true },
    { kind: "available", version: "1.2.3" },
    { kind: "ready", version: "1.2.3" },
    { kind: "retrying", version: "1.2.3" },
  ])("is taken as $kind", (offer) => {
    expect(parseUpdateOffer(offer)).toEqual(offer)
  })

  it("keeps only what the contract allows", () => {
    expect(parseUpdateOffer({ kind: "ready", version: "1.2.3", percent: 9, extra: 1 })).toEqual({
      kind: "ready",
      version: "1.2.3",
    })
    expect(parseUpdateOffer({ kind: "available", version: "1.2.3", allow: "yes" })).toEqual({
      kind: "available",
      version: "1.2.3",
    })
  })

  it.each([
    ["a version that is no release's", { kind: "ready", version: "1.2" }],
    ["a version that runs on", { kind: "ready", version: `1.2.3-${"a".repeat(65)}` }],
    ["a percent past 100", { kind: "downloading", version: "1.2.3", percent: 101 }],
    ["a fractional percent", { kind: "downloading", version: "1.2.3", percent: 4.5 }],
    ["an unknown kind", { kind: "installed", version: "1.2.3" }],
    ["nothing", null],
  ])("is nothing with %s", (_name, value) => {
    expect(parseUpdateOffer(value)).toBeUndefined()
  })
})

describe("a badge from the page", () => {
  it("is a count from 0 to 999, with no image or a small PNG", () => {
    expect(desktopBadgeOf({ count: 0, image: null })).toEqual({ count: 0, image: null })
    const image = "data:image/png;base64,iVBORw0KGgo="
    expect(desktopBadgeOf({ count: 999, image })).toEqual({ count: 999, image })
  })

  it.each([
    ["a negative count", { count: -1, image: null }],
    ["a count past 999", { count: 1000, image: null }],
    ["a fractional count", { count: 1.5, image: null }],
    ["an image that isn't a PNG", { count: 1, image: "data:image/svg+xml;base64,PHN2Zz4=" }],
    ["an image too large", { count: 1, image: `data:image/png;base64,${"A".repeat(16_384)}` }],
    ["no image at all", { count: 1 }],
  ])("is nothing with %s", (_name, value) => {
    expect(desktopBadgeOf(value)).toBeUndefined()
  })
})

describe("what is new from an older host", () => {
  const item = (n: number) => ({ title: `Title ${n}`, line: `Line ${n}.` })

  it("ignores a heads-up field, and has nothing to show with only heads-ups", () => {
    expect(parseWhatsNew({ version: "1.5.0", highlights: [item(1)], headsUp: [item(2)] })).toEqual({
      version: "1.5.0",
      highlights: [item(1)],
    })
    expect(parseWhatsNew({ version: "1.5.0", highlights: [], headsUp: [item(1)] })).toBeUndefined()
  })
})
