import { describe, expect, it } from "../test"
import { watchScale } from "./scale"

// A store holding the scale, and the scales the window was told.
const watched = (start: 80 | 100 | 200, show?: (scale: number) => void) => {
  let appScale = start
  const listeners = new Set<() => void>()
  const store = {
    getSnapshot: () => ({ preferences: { appScale } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  const choose = (next: 80 | 100 | 200): void => {
    appScale = next
    listeners.forEach((listener) => listener())
  }
  return { stop: watchScale(store, show), choose, listeners }
}

describe("telling the window the app's scale", () => {
  it("tells it the saved scale as a fraction at the start, and each choice after", () => {
    const told: number[] = []
    const { choose } = watched(200, (scale) => told.push(scale))
    expect(told).toEqual([2])
    choose(80)
    choose(100)
    expect(told).toEqual([2, 0.8, 1])
  })

  it("tells it nothing again when something else in the preferences changes", () => {
    const told: number[] = []
    const { choose } = watched(100, (scale) => told.push(scale))
    choose(100)
    expect(told).toEqual([1])
  })

  it("stops listening when stopped", () => {
    const { stop, listeners } = watched(100, () => {})
    stop()
    expect(listeners.size).toBe(0)
  })

  it("does nothing where nothing surrounds the page", () => {
    const { listeners, choose } = watched(100)
    choose(200)
    expect(listeners.size).toBe(0)
  })
})
