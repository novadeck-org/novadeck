import { afterEach, describe, expect, it } from "vitest"

import { paneTurnsGroup, togglePanePictures, togglePaneTurns } from "./pane-turns"

afterEach(() => {
  document.documentElement.removeAttribute("data-pane-turns-held")
  document.documentElement.removeAttribute("data-pane-pictures-sketched")
})

describe("the pane turns toggles", () => {
  it("holds the panes' turns, and lets them go when pressed again", () => {
    togglePaneTurns()
    expect(document.documentElement.hasAttribute("data-pane-turns-held")).toBe(true)
    togglePaneTurns()
    expect(document.documentElement.hasAttribute("data-pane-turns-held")).toBe(false)
  })

  it("has panes pictured as sketches, and stops when pressed again", () => {
    togglePanePictures()
    expect(document.documentElement.hasAttribute("data-pane-pictures-sketched")).toBe(true)
    togglePanePictures()
    expect(document.documentElement.hasAttribute("data-pane-pictures-sketched")).toBe(false)
  })

  it("sits in the App section", () => {
    expect(paneTurnsGroup.section).toBe("App")
    expect(paneTurnsGroup.actions.map((action) => action.label)).toEqual([
      "Hold panes' turns",
      "Sketch panes' pictures",
    ])
  })
})
