import { terminalFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../test"
import {
  cycleRecent,
  moveRecent,
  nextRecent,
  openRecent,
  visibleSwitcher,
  withoutGone,
} from "./recent"

const ordered = [1, 2, 3].map((number) => terminalFixture(number, "~/project"))

describe("recent terminals", () => {
  context("when the selection changes", () => {
    it("puts it first, keeps the earlier order and appends new terminals in sidebar order", () => {
      expect(nextRecent([], "02", ordered)).toEqual(["02", "01", "03"])
      expect(nextRecent(["02", "01", "03"], "03", ordered)).toEqual(["03", "02", "01"])
      expect(nextRecent(["03", "gone", "02"], "", ordered)).toEqual(["03", "02", "01"])
    })
  })

  context("when opened with a click", () => {
    it("highlights the terminal it was opened from, or the first one", () => {
      expect(openRecent("a", ["01", "02"], "02")).toMatchObject({ index: 1, mode: "click" })
      expect(openRecent("a", ["01", "02"], "gone").index).toBe(0)
    })
  })

  context("when cycling with Ctrl+Tab", () => {
    const start = { context: "a", ids: ["02", "01", "03"], selected: "02", fromInput: true }

    it("opens held one step from the selection and wraps while open", () => {
      const opened = cycleRecent(null, start, 1)!
      expect(opened).toMatchObject({ index: 1, mode: "held", fromInput: true })
      expect(cycleRecent(opened, start, 1)!.index).toBe(2)
      expect(cycleRecent(opened, start, -1)!.index).toBe(0)
      expect(cycleRecent(null, start, -1)!.index).toBe(2)
    })

    it("starts before the first terminal when nothing is selected", () => {
      expect(cycleRecent(null, { ...start, selected: "" }, 1)!.index).toBe(0)
      expect(cycleRecent(null, { ...start, selected: "" }, -1)!.index).toBe(1)
    })

    it("keeps a click-mode switcher in click mode", () => {
      const clicked = openRecent("a", start.ids, "02")
      expect(cycleRecent(clicked, { ...start, fromInput: true }, 1)).toMatchObject({
        mode: "click",
        fromInput: false,
      })
    })

    it("has nothing to switch between with fewer than two terminals", () => {
      expect(cycleRecent(null, { ...start, ids: ["02"] }, 1)).toBeNull()
    })
  })

  context("when moving the highlight", () => {
    it("wraps around both ends", () => {
      const switcher = openRecent("a", ["01", "02"], "02")
      expect(moveRecent(switcher, 1).index).toBe(0)
      expect(moveRecent(moveRecent(switcher, 1), -1).index).toBe(1)
    })
  })

  context("when deciding whether it shows", () => {
    it("shows only in its own session and never above a dialog", () => {
      const switcher = openRecent("a", ["01", "02"], "01")
      expect(visibleSwitcher(switcher, "a", null)).toBe(switcher)
      expect(visibleSwitcher(switcher, "b", null)).toBeNull()
      expect(visibleSwitcher(switcher, "a", "search")).toBeNull()
    })
  })

  context("when a terminal closes while it shows", () => {
    const at = (index: number) => ({ ...openRecent("a", ["01", "02", "03", "04"], "01"), index })
    const without =
      (...gone: string[]) =>
      (id: string) =>
        !gone.includes(id)

    it("keeps the highlight on its row, which moves up past the rows that went", () => {
      expect(withoutGone(at(2), without("01"))).toMatchObject({ ids: ["02", "03", "04"], index: 1 })
      expect(withoutGone(at(1), without("04"))).toMatchObject({ ids: ["01", "02", "03"], index: 1 })
    })

    it("moves the highlight to the row that takes the place of its own, or the last", () => {
      expect(withoutGone(at(1), without("02"))).toMatchObject({ ids: ["01", "03", "04"], index: 1 })
      expect(withoutGone(at(3), without("04"))).toMatchObject({ ids: ["01", "02", "03"], index: 2 })
    })

    it("closes once no row is left, and stays the same where none went", () => {
      const switcher = at(0)
      expect(withoutGone(switcher, () => false)).toBeNull()
      expect(withoutGone(switcher, () => true)).toBe(switcher)
    })
  })
})
