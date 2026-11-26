import { describe, expect, it } from "./test"
import { isTourFolder } from "./tour-folder"

describe("isTourFolder", () => {
  it("accepts the tour's folder and the numbered ones after it, up to 99", () => {
    for (const directory of [
      "~/.novadeck/tour",
      "/home/me/.novadeck/tour/",
      "C:\\Users\\me\\.novadeck\\tour-2",
      "/home/me/.novadeck/tour-9",
      "/home/me/.novadeck/tour-99",
    ])
      expect(isTourFolder(directory)).toBe(true)
  })

  it("refuses anything else", () => {
    for (const directory of [
      "/home/me/tour",
      "/home/me/.novadeck/tour-0",
      "/home/me/.novadeck/tour-100",
      "/home/me/.novadeck/tours",
      "/home/me/.novadeck/tour/src",
      "/home/me/.novadeck/worktrees/tour",
    ])
      expect(isTourFolder(directory)).toBe(false)
  })
})
