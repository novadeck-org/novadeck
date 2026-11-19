import { describe, expect, it } from "vitest"

import { guestMark, guestScript, guestZoomed, isKeptZoom, parseGuest } from "./zoom.js"

describe("what a zoomed phone's page says", () => {
  it("is Esc, or Shift+scroll with how far, and nothing of anything else it logs", () => {
    expect(parseGuest(`${guestMark}esc`)).toEqual({ key: "esc" })
    expect(parseGuest(`${guestMark}wheel 120`)).toEqual({ wheel: 120 })
    expect(parseGuest(`${guestMark}wheel -40.5`)).toEqual({ wheel: -40.5 })
    expect(parseGuest(`${guestMark}wheel nope`)).toBeUndefined()
    expect(parseGuest(`${guestMark}other`)).toBeUndefined()
    expect(parseGuest("a log of the page's own")).toBeUndefined()
    expect(parseGuest(undefined)).toBeUndefined()
  })

  it("is said by a script that runs, once a document, and starts as the phone is", () => {
    for (const zoomed of [true, false]) {
      expect(guestScript(zoomed)).toContain(`{ zoomed: ${zoomed} }`)
      // It runs where there are no keys and no wheel to hear, and as often as it's given.
      const scope: Record<string, unknown> = {
        console: { debug: () => undefined },
        addEventListener: () => undefined,
      }
      const run = new Function(
        "window",
        "console",
        "addEventListener",
        `return ${guestScript(zoomed)}`,
      )
      run(scope, scope.console, scope.addEventListener)
      run(scope, scope.console, scope.addEventListener)
      expect(scope.novadeckPhoneZoom).toEqual({ zoomed })
    }
    expect(guestZoomed(true)).toContain("zoomed = true")
  })

  it("keeps a lift from the top to the bottom of the travel, and no other", () => {
    expect(isKeptZoom({ lift: 0 })).toBe(true)
    expect(isKeptZoom({ lift: 1 })).toBe(true)
    expect(isKeptZoom({ lift: 1.5 })).toBe(false)
    expect(isKeptZoom({ lift: -1 })).toBe(false)
    expect(isKeptZoom({ lift: "0" })).toBe(false)
    expect(isKeptZoom(null)).toBe(false)
  })
})
