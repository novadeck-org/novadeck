import { describe, expect, it } from "vitest"

import { stackGap, teamRoute, type Member, type Rect } from "./team-route"

// Where a window's header line sits below its top.
const header = 13
const lead: Rect = { x: 100, y: 100, width: 200, height: 150 }
const at = (id: string, x: number, y: number, width = 200, height = 150): Member => ({
  id,
  x,
  y,
  width,
  height,
})

describe("The team wire's route on the canvas", () => {
  it("starts at the lead's right edge on its header line, for workers to its right", () => {
    const route = teamRoute(lead, [at("a", 500, 40), at("b", 600, 300)], header)!
    const [side] = route.sides
    expect(side!.cursor).toEqual({ x: 300, y: 113 })
    // The trunk stands midway between the lead's edge and the nearest worker's.
    expect(side!.trunk).toEqual({ from: { x: 400, y: 53 }, to: { x: 400, y: 313 } })
    expect(side!.stem).toEqual({ from: { x: 300, y: 113 }, to: { x: 400, y: 113 } })
  })

  it("ticks into each worker's left edge on its header line", () => {
    const route = teamRoute(lead, [at("a", 500, 40), at("b", 600, 300)], header)!
    expect(route.ticks).toEqual([
      { id: "a", run: { from: { x: 400, y: 53 }, to: { x: 500, y: 53 } } },
      { id: "b", run: { from: { x: 400, y: 313 }, to: { x: 600, y: 313 } } },
    ])
  })

  it("mirrors for workers to the left: the lead's left edge and the workers' right edges", () => {
    const route = teamRoute(lead, [at("a", -200, 20), at("b", -150, 200)], header)!
    expect(route.sides.map((side) => side.cursor)).toEqual([{ x: 100, y: 113 }])
    expect(route.sides[0]!.trunk.from.x).toBe(75)
    expect(route.ticks.map((tick) => tick.run.to)).toEqual([
      { x: 0, y: 33 },
      { x: 50, y: 213 },
    ])
  })

  it("runs on the left, clear of the lead, for workers above and below it", () => {
    const route = teamRoute(lead, [at("a", 120, -200), at("b", 80, 400, 300)], header)!
    expect(route.sides.map((side) => side.cursor)).toEqual([{ x: 100, y: 113 }])
    expect(route.sides[0]!.trunk.from.x).toBe(80 - stackGap)
    // Each tick runs into the worker's left edge.
    expect(route.ticks.map((tick) => tick.run.to.x)).toEqual([120, 80])
  })

  it("puts stacked workers on the right when workers left of the lead have the left", () => {
    const route = teamRoute(lead, [at("a", 120, -200), at("l", -200, 100)], header)!
    const stacked = route.ticks.find((tick) => tick.id === "a")!
    expect(stacked.run.from.x).toBe(320 + stackGap)
    expect(stacked.run.to.x).toBe(320)
    expect(route.sides.map((side) => side.cursor.x)).toEqual([100, 300])
  })

  it("draws a trunk for each side of a mixed team, with a cursor on each edge", () => {
    const route = teamRoute(lead, [at("r", 500, 100), at("l", -200, 100)], header)!
    expect(route.sides.map((side) => side.cursor.x)).toEqual([300, 100])
    expect(route.sides.map((side) => side.trunk.from.x)).toEqual([400, 50])
  })

  it("puts stacked workers on the left when only workers right of the lead have a trunk", () => {
    const route = teamRoute(lead, [at("r", 500, 100), at("s", 120, -200)], header)!
    expect(route.sides.map((side) => [side.side, side.trunk.from.x])).toEqual([
      ["right", 400],
      ["left", 100 - stackGap],
    ])
  })

  it("joins stacked workers to a trunk of the side they are nearer to, in a team on three sides", () => {
    // The case where a trunk of their own would have fallen on the right trunk's place.
    const workers = [at("l", -300, 100), at("r", 364, 100), at("s", 100, -200)]
    const route = teamRoute(lead, workers, header)!
    expect(route.sides.map((side) => side.side)).toEqual(["right", "left"])
    const places = route.sides.map((side) => side.trunk.from.x)
    expect(new Set(places).size).toBe(places.length)
    // The stacked worker (middle 200, the lead's) takes the left on a tie, into its left edge,
    // with the trunk moved out beyond it.
    const stacked = route.ticks.find((tick) => tick.id === "s")!
    expect(stacked.run.to.x).toBe(100)
    expect(stacked.run.from.x).toBe(places[1])
    expect(places[1]).toBeLessThan(100)
  })

  it("joins stacked workers to the right trunk when their middle is nearer it", () => {
    const workers = [at("l", -300, 100), at("r", 500, 100), at("s", 250, -200, 100)]
    const route = teamRoute(lead, workers, header)!
    expect(route.sides.map((side) => side.side)).toEqual(["right", "left"])
    const stacked = route.ticks.find((tick) => tick.id === "s")!
    expect(stacked.run.to.x).toBe(350)
    // The right trunk was midway (400) and clear of the worker's right edge: it stays.
    expect(stacked.run.from.x).toBe(400)
    expect(route.sides[0]!.trunk.from.x).toBe(400)
  })

  it("draws a worker level with the lead as a straight line", () => {
    const route = teamRoute(lead, [at("a", 500, 100)], header)!
    expect(route.sides[0]!.trunk).toEqual({ from: { x: 400, y: 113 }, to: { x: 400, y: 113 } })
    expect(route.paths[0]).toMatchObject({
      id: "a",
      length: 400 - 300 + 500 - 400,
    })
  })

  it("measures each worker's path from the lead", () => {
    const route = teamRoute(lead, [at("a", 500, 40)], header)!
    expect(route.paths[0]!.points).toEqual([
      { x: 300, y: 113 },
      { x: 400, y: 113 },
      { x: 400, y: 53 },
      { x: 500, y: 53 },
    ])
    expect(route.paths[0]!.length).toBe(100 + 60 + 100)
  })

  it("has no route without a lead or without a worker", () => {
    expect(teamRoute(undefined, [at("a", 500, 40)], header)).toBeUndefined()
    expect(teamRoute(lead, [], header)).toBeUndefined()
  })
})
