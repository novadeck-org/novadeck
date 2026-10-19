import { context, describe, expect, it } from "../test"
import { blinkMs, wireShape } from "./team-wire"

const view = { top: 100, bottom: 700 }
const at = (id: string, y: number) => ({ id, y, left: 56 })

describe("the team's wire", () => {
  context("when the whole team is in view", () => {
    const shape = wireShape(43, view, at("lead", 150), [at("a", 300), at("b", 450)])!

    it("lights the border from the lead to the last worker", () => {
      expect([shape.top, shape.bottom]).toEqual([150, 450])
    })

    it("puts the cursor on the lead and a tick into each worker, reaching its tab", () => {
      expect(shape.lead).toBe(150)
      expect(shape.taps.map(({ id, y, width }) => ({ id, y, width }))).toEqual([
        { id: "a", y: 300, width: 12 },
        { id: "b", y: 450, width: 12 },
      ])
    })

    it("sends the pulse down from the lead after the blink, reaching nearer workers first", () => {
      expect(shape.pulse).toMatchObject({ up: 0, down: 300 })
      const [near, far] = shape.taps
      expect(near!.at).toBeGreaterThan(blinkMs)
      expect(far!.at).toBeGreaterThan(near!.at)
    })
  })

  context("when the lead sits between its workers", () => {
    const shape = wireShape(43, view, at("lead", 300), [at("a", 150), at("b", 450)])!

    it("spans the topmost member to the bottommost", () => {
      expect([shape.top, shape.bottom]).toEqual([150, 450])
    })

    it("sends the pulse both ways from the lead", () => {
      expect(shape.pulse).toMatchObject({ up: 150, down: 150 })
    })
  })

  context("when part of the team is out of view", () => {
    const shape = wireShape(43, view, at("lead", 40), [at("a", 300), at("b", 900)])!

    it("runs on into the list's edges", () => {
      expect([shape.top, shape.bottom]).toEqual([100, 700])
    })

    it("draws no cursor, no pulse and no tick for those out of view", () => {
      expect(shape.lead).toBeUndefined()
      expect(shape.pulse).toBeUndefined()
      expect(shape.taps.map((tap) => tap.id)).toEqual(["a"])
    })
  })

  context("when the whole team is out of view on one side", () => {
    it("draws nothing", () => {
      expect(wireShape(43, view, at("lead", 720), [at("a", 800)])).toBeUndefined()
    })
  })
})
