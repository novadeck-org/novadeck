import { context, describe, expect, it } from "../test"
import { wireShape } from "./team-wire"

const view = { top: 100, bottom: 700 }
const at = (id: string, y: number, left = 56) => ({ id, y, left })

describe("the team's wire", () => {
  context("when the whole team is in view", () => {
    const shape = wireShape(43, view, at("lead", 150), [at("a", 300), at("b", 450)])!

    it("runs the border from the lead's row down to the last worker's, that row included", () => {
      expect([shape.top, shape.height]).toEqual([150, 301])
    })

    it("puts the cursor on the lead", () => {
      expect(shape.lead).toBe(150)
    })

    it("starts each worker's tick on the wire's own column and reaches 3px into its tab", () => {
      expect(shape.taps).toEqual([
        { id: "a", y: 300, width: 16 },
        { id: "b", y: 450, width: 16 },
      ])
      // From the wire's column, x = 43, to 3px past the tab's left edge at 56.
      expect(shape.x + shape.taps[0]!.width).toBe(56 + 3)
    })
  })

  context("when the tabs sit between whole pixels, at a fractional display scale", () => {
    const shape = wireShape(43.2, view, at("lead", 150.4, 55.6), [at("a", 300.6, 56.4)])!

    it("rounds every position to a whole pixel, so the joints meet", () => {
      expect(shape.x).toBe(43)
      expect([shape.top, shape.height, shape.lead]).toEqual([150, 152, 150])
      expect(shape.taps).toEqual([{ id: "a", y: 301, width: 16 }])
      // The tick's row is the segment's last.
      expect(shape.top + shape.height - 1).toBe(shape.taps[0]!.y)
    })
  })

  context("when the lead sits between its workers", () => {
    const shape = wireShape(43, view, at("lead", 300), [at("a", 150), at("b", 450)])!

    it("spans the topmost member to the bottommost", () => {
      expect([shape.top, shape.top + shape.height - 1]).toEqual([150, 450])
      expect(shape.lead).toBe(300)
    })
  })

  context("when part of the team is out of view", () => {
    const shape = wireShape(43, view, at("lead", 40), [at("a", 300), at("b", 900)])!

    it("runs on into the list's edges", () => {
      expect([shape.top, shape.top + shape.height - 1]).toEqual([100, 700])
    })

    it("draws no cursor and no tick for those out of view", () => {
      expect(shape.lead).toBeUndefined()
      expect(shape.taps.map((tap) => tap.id)).toEqual(["a"])
    })
  })

  context("when the whole team is out of view on one side", () => {
    it("draws nothing", () => {
      expect(wireShape(43, view, at("lead", 720), [at("a", 800)])).toBeUndefined()
    })
  })
})
