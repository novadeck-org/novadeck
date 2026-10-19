import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { createPinDrop } from "./pin-drop"
import type { ProjectArrangement } from "./project-arrangement"

const before: ProjectArrangement = { order: ["a", "b", "c"], pinned: ["a"] }

const channel = () => {
  let arrangement = before
  const pin = vi.fn<(id: string, index: number) => void>((id, index) => {
    const pinned = arrangement.pinned.filter((other) => other !== id)
    pinned.splice(Math.min(index, pinned.length), 0, id)
    arrangement = { ...arrangement, pinned }
  })
  const restore = vi.fn<(next: ProjectArrangement) => void>((next) => {
    arrangement = next
  })
  const drop = createPinDrop({ pin, current: () => arrangement, restore })
  return { drop, pin, restore, arrangement: () => arrangement }
}

describe("createPinDrop", () => {
  it("tells the drag in the list and whether the bar can take it", () => {
    const { drop } = channel()
    drop.start("b", true)
    expect(drop.getSnapshot()).toEqual({ drag: { id: "b", accepts: true }, handoff: null })
    drop.end()
    expect(drop.getSnapshot()).toEqual({ drag: null, handoff: null })
  })

  it("pins the project where the bar places the point, and hands the drag over", () => {
    const { drop, pin, arrangement } = channel()
    drop.setLocate(() => 0)
    drop.start("b", true)
    expect(drop.handOff({ x: 10, y: 20 })).toBe(true)
    expect(pin).toHaveBeenCalledWith("b", 0)
    expect(arrangement().pinned).toEqual(["b", "a"])
    expect(drop.getSnapshot().handoff).toEqual({
      id: "b",
      point: { x: 10, y: 20 },
      wasPinned: false,
    })
  })

  it("tells whether the handed-over project was pinned before", () => {
    const { drop } = channel()
    drop.start("a", true)
    drop.handOff({ x: 0, y: 0 })
    expect(drop.getSnapshot().handoff?.wasPinned).toBe(true)
  })

  it("pins it last where no bar places points", () => {
    const { drop, arrangement } = channel()
    drop.start("c", true)
    drop.handOff({ x: 0, y: 0 })
    expect(arrangement().pinned).toEqual(["a", "c"])
  })

  it("tells of the handoff before it pins, so the bar knows the pin as handed over", () => {
    const { drop, pin } = channel()
    const seen: (string | undefined)[] = []
    drop.subscribe(() => seen.push(drop.getSnapshot().handoff?.id))
    pin.mockImplementation(() => {
      seen.push(`pinned with handoff ${drop.getSnapshot().handoff?.id}`)
    })
    drop.start("b", true)
    drop.handOff({ x: 0, y: 0 })
    expect(seen).toEqual([undefined, "b", "pinned with handoff b"])
  })

  it("hands nothing over where the bar can't take it, or with no drag, or twice", () => {
    const { drop, pin } = channel()
    expect(drop.handOff({ x: 0, y: 0 })).toBe(false)
    drop.start("b", false)
    expect(drop.handOff({ x: 0, y: 0 })).toBe(false)
    drop.start("c", true)
    expect(drop.handOff({ x: 0, y: 0 })).toBe(true)
    expect(drop.handOff({ x: 0, y: 0 })).toBe(false)
    expect(pin).toHaveBeenCalledTimes(1)
  })

  it("puts the arrangement back when the bar's drag is canceled or let go off the bar", () => {
    const { drop, restore, arrangement } = channel()
    drop.start("b", true)
    drop.handOff({ x: 0, y: 0 })
    drop.end()
    drop.settle(true)
    expect(restore).toHaveBeenCalledWith(before)
    expect(arrangement()).toEqual(before)
    expect(drop.getSnapshot()).toEqual({ drag: null, handoff: null })
  })

  it("keeps the pin when the bar's drag ends on the bar", () => {
    const { drop, restore, arrangement } = channel()
    drop.start("b", true)
    drop.handOff({ x: 0, y: 0 })
    drop.end()
    drop.settle(false)
    expect(restore).not.toHaveBeenCalled()
    expect(arrangement().pinned).toEqual(["a", "b"])
    expect(drop.getSnapshot().handoff).toBeNull()
  })

  it("restores only the arrangement from before the handoff it settles", () => {
    const { drop, restore } = channel()
    drop.start("b", true)
    drop.handOff({ x: 0, y: 0 })
    drop.settle(false)
    drop.settle(true)
    expect(restore).not.toHaveBeenCalled()
  })

  it("stops telling a listener that unsubscribed", () => {
    const { drop } = channel()
    const listener = vi.fn<() => void>()
    const unsubscribe = drop.subscribe(listener)
    drop.start("b", true)
    unsubscribe()
    drop.end()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
