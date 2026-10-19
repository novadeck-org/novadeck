import { afterEach, describe, expect, it } from "vitest"

import { iconGuidesGroup, restoreIconGuides, toggleIconGuides } from "./icon-guides"

const shown = (): boolean => document.documentElement.hasAttribute("data-icon-guides")

describe("icon guides", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-icon-guides")
    window.sessionStorage.clear()
  })

  it("toggles the guides on the page's root", () => {
    toggleIconGuides()
    expect(shown()).toBe(true)
    toggleIconGuides()
    expect(shown()).toBe(false)
  })

  it("brings them back after a reload while they were on", () => {
    toggleIconGuides()
    document.documentElement.removeAttribute("data-icon-guides")
    restoreIconGuides()
    expect(shown()).toBe(true)
    toggleIconGuides()
    restoreIconGuides()
    expect(shown()).toBe(false)
  })

  it("lists its toggle under App", () => {
    expect(iconGuidesGroup.section).toBe("App")
    expect(iconGuidesGroup.actions.map((action) => action.label)).toEqual(["Toggle icon guides"])
  })
})
