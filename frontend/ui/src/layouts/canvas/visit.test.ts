import { describe, expect, it } from "vitest"

import { createCanvasVisit } from "./visit"

const origin = { x: 24, y: -48, zoom: 0.6 }
const destination = { x: -600, y: -400, zoom: 1.5 }

describe("a Canvas camera visit", () => {
  it("ignores repeated fly gestures during a flight, then returns to the original camera", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    expect(visit.begin("one", origin, destination)).toBeNull()
    visit.finish(flight)
    const back = visit.begin("one", destination, destination)!
    expect(back.viewport).toEqual(origin)
    visit.finish(back)
    expect(visit.visiting).toBe(false)
  })

  it("queues Escape during a flight and returns when the flight completes", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    expect(visit.back()).toBeNull()
    const back = visit.finish(flight)!
    expect(back.viewport).toEqual(origin)
    visit.finish(back)
    expect(visit.visiting).toBe(false)
  })

  it("rests where it began, whether flying there, visiting, or flying back", () => {
    const visit = createCanvasVisit()
    expect(visit.home).toBeNull()
    const flight = visit.begin("one", origin, destination)!
    expect(visit.home).toEqual(origin)
    visit.finish(flight)
    expect(visit.home).toEqual(origin)
    const back = visit.back()!
    expect(visit.home).toEqual(origin)
    visit.finish(back)
    expect(visit.home).toBeNull()
  })

  it("starts a visit to another terminal from the current camera", () => {
    const visit = createCanvasVisit()
    visit.finish(visit.begin("one", origin, destination)!)
    visit.finish(visit.begin("two", destination, { x: 0, y: 0, zoom: 2 })!)
    expect(visit.back()?.viewport).toEqual(destination)
  })

  it("flies in to a terminal entered from outside, and stays when already there", () => {
    const visit = createCanvasVisit()
    const flight = visit.enter("one", origin, destination)!
    expect(flight.viewport).toEqual(destination)
    visit.finish(flight)
    expect(visit.enter("one", destination, destination)).toBeNull()
    expect(visit.back()?.viewport).toEqual(origin)
  })

  it("stays at a terminal entered while flying to it, though the way back was asked", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    visit.back()
    expect(visit.enter("one", origin, destination)).toBeNull()
    expect(visit.finish(flight)).toBeNull()
    expect(visit.visiting).toBe(true)
  })

  it("takes over a flight from one entered during it, keeping that visit's way back", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    const other = { x: 0, y: 0, zoom: 2 }
    const taken = visit.enter("two", destination, other)!
    expect(taken.viewport).toEqual(other)
    expect(visit.finish(flight)).toBeNull()
    visit.finish(taken)
    expect(visit.back()?.viewport).toEqual(origin)
  })

  it("takes over a visit from one entered after it, keeping that visit's way back", () => {
    const visit = createCanvasVisit()
    visit.finish(visit.begin("one", origin, destination)!)
    const other = { x: 0, y: 0, zoom: 2 }
    const taken = visit.enter("two", destination, other)!
    expect(taken.viewport).toEqual(other)
    visit.finish(taken)
    expect(visit.back()?.viewport).toEqual(origin)
  })

  it("manual camera changes invalidate an outstanding flight and its return point", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    visit.back()
    visit.clear()
    expect(visit.finish(flight)).toBeNull()
    expect(visit.back()).toBeNull()
    expect(visit.visiting).toBe(false)
  })

  it("failed animation clears the return point", () => {
    const visit = createCanvasVisit()
    const flight = visit.begin("one", origin, destination)!
    visit.finish(flight, false)
    expect(visit.visiting).toBe(false)
    expect(visit.back()).toBeNull()
  })
})
