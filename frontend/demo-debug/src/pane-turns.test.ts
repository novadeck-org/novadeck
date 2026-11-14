import { afterEach, describe, expect, it } from "vitest"

import { paneTurnsGroup, togglePaneTurns } from "./pane-turns"

afterEach(() => document.documentElement.removeAttribute("data-pane-turns-held"))

describe("the pane turns toggle", () => {
  it("holds the panes' turns, and lets them go when pressed again", () => {
    togglePaneTurns()
    expect(document.documentElement.hasAttribute("data-pane-turns-held")).toBe(true)
    togglePaneTurns()
    expect(document.documentElement.hasAttribute("data-pane-turns-held")).toBe(false)
  })

  it("sits in the App section", () => {
    expect(paneTurnsGroup.section).toBe("App")
    expect(paneTurnsGroup.actions.map((action) => action.label)).toEqual(["Hold panes' turns"])
  })
})
