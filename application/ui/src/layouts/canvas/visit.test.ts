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

  it("starts a visit to another terminal from the current camera", () => {
    const visit = createCanvasVisit()
    visit.finish(visit.begin("one", origin, destination)!)
    visit.finish(visit.begin("two", destination, { x: 0, y: 0, zoom: 2 })!)
    expect(visit.back()?.viewport).toEqual(destination)
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
