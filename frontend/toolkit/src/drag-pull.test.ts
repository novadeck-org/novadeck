import { defaultPull, overflow, pull, PullOut, pullWithin, roomAlong, stretch } from "./drag-pull"
import { describe, expect, it } from "./test"

const feel = { give: 20, breakAt: 60 }

describe("a pull out of a list", () => {
  it("stretches half its give at its give, and never past all of it", () => {
    expect(stretch(20, 20)).toBe(10)
    expect(stretch(1_000, 20)).toBeLessThan(20)
    expect(stretch(1_000, 20)).toBeGreaterThan(19)
  })

  it("rests at the edge, unmoved and slack", () => {
    expect(pull({ x: 0, y: 0 }, feel)).toEqual({ tension: 0, free: false, shown: { x: 0, y: 0 } })
  })

  it("resists along the pointer's way out, tauter the further it goes", () => {
    const near = pull({ x: -30, y: 0 }, feel)
    const far = pull({ x: -50, y: 0 }, feel)
    expect(near.free).toBe(false)
    expect(near.shown.x).toBeCloseTo(-12)
    expect(near.shown.y).toBe(0)
    expect(near.tension).toBeCloseTo(0.5)
    expect(far.tension).toBeGreaterThan(near.tension)
    expect(Math.abs(far.shown.x)).toBeLessThan(feel.give)
  })

  it("breaks free once the pointer is far enough out, at any angle", () => {
    expect(pull({ x: -36, y: 48 }, feel)).toEqual({
      tension: 1,
      free: true,
      shown: { x: -36, y: 48 },
    })
  })

  it("feels the same everywhere unless a list asks otherwise", () => {
    expect(pull({ x: defaultPull.breakAt, y: 0 }).free).toBe(true)
    expect(pull({ x: defaultPull.breakAt - 1, y: 0 }).free).toBe(false)
  })
})

describe("a pull with little room to go", () => {
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 }

  it("measures the room left along the pointer's way out", () => {
    expect(roomAlong({ x: 90, y: 300 }, { x: -5, y: 1 }, bounds)).toBe(90)
    expect(roomAlong({ x: 90, y: 300 }, { x: 0, y: 5 }, bounds)).toBe(300)
  })

  it("breaks within most of that room, so a pull that way can always free it", () => {
    expect(pullWithin(feel, 40)).toEqual({ give: 20, breakAt: 34 })
    expect(pullWithin(feel, 1000)).toBe(feel)
  })

  it("never breaks before it has given its stretch", () => {
    expect(pullWithin(feel, 4).breakAt).toBe(feel.give)
  })
})

describe("how far a moved box goes past its bounds", () => {
  const bounds = { left: 0, top: 0, right: 200, bottom: 400 }
  const box = { left: 10, top: 10, right: 190, bottom: 60 }

  it("is nothing inside", () => {
    expect(overflow(box, { x: 5, y: 100 }, bounds)).toEqual({ x: 0, y: 0 })
  })

  it("is how far each edge went out, left and up negative", () => {
    expect(overflow(box, { x: -30, y: 380 }, bounds)).toEqual({ x: -20, y: 40 })
  })
})

describe("a list's drag with the pull-out modifier", () => {
  // A fake drag manager: what the modifier listens to, and the drags it is told of.
  const managed = () => {
    const listeners = new Map<string, () => void>()
    const manager = {
      monitor: {
        addEventListener: (name: string, handler: () => void) => {
          listeners.set(name, handler)
          return () => listeners.delete(name)
        },
      },
    }
    return { manager, emit: (name: string) => listeners.get(name)?.() }
  }
  const boxed = (left: number, top: number, right: number, bottom: number): Element =>
    ({
      getBoundingClientRect: () => ({ left, top, right, bottom }),
    }) as Element
  // A tab 200 wide and 60 tall at the list's top left, the list 200 wide and 400 tall.
  const list = boxed(0, 0, 200, 400)
  const within = boxed(-100, -100, 1000, 1000)
  // The pointer took hold at the tab's middle, 100 from the list's left.
  const operation = (x: number, y: number, keyboard = false, grab = { x: 100, y: 30 }) =>
    ({
      transform: { x, y },
      position: { initial: grab },
      shape: { initial: { boundingRectangle: { left: 0, top: 0, right: 200, bottom: 60 } } },
      status: { idle: false },
      source: null,
      activatorEvent: keyboard ? new KeyboardEvent("keydown") : new PointerEvent("pointerdown"),
    }) as never
  const modifier = (pulls: { tension: number; free: boolean }[] = []) => {
    const { manager, emit } = managed()
    const pullOut = new PullOut(manager as never, {
      element: list,
      within,
      feel: { give: 20, breakAt: 60 },
      onPull: (each) => pulls.push(each),
    })
    return { pullOut, emit }
  }

  it("follows the pointer inside the list", () => {
    const { pullOut } = modifier()
    expect(pullOut.apply(operation(0, 120))).toEqual({ x: 0, y: 120 })
  })

  it("holds the element at the edge, stretching less than the pointer goes", () => {
    const pulls: { tension: number; free: boolean }[] = []
    const { pullOut } = modifier(pulls)
    const moved = pullOut.apply(operation(-30, 0))
    expect(moved.x).toBeCloseTo(-12)
    expect(pulls.at(-1)).toEqual({ tension: 0.5, free: false })
  })

  it("lets it go once pulled far enough, and keeps it free for the rest of the drag", () => {
    const pulls: { tension: number; free: boolean }[] = []
    const { pullOut } = modifier(pulls)
    expect(pullOut.apply(operation(-70, 0))).toEqual({ x: -70, y: 0 })
    expect(pulls.at(-1)).toEqual({ tension: 1, free: true })
    expect(pullOut.apply(operation(-10, 0))).toEqual({ x: -10, y: 0 })
  })

  it("lets go sooner where there's little room that way", () => {
    const pulls: { tension: number; free: boolean }[] = []
    const { pullOut } = modifier(pulls)
    // Held 40 from the far left edge of where it may go: it gives within 34 of it.
    pullOut.apply(operation(-36, 0, false, { x: -60, y: 30 }))
    expect(pulls.at(-1)).toEqual({ tension: 1, free: true })
  })

  it("glides to the pointer as it breaks free, then is free, and shows how it is pulled", async () => {
    const { manager } = managed()
    const element = document.createElement("div")
    const pullOut = new PullOut(manager as never, {
      element: list,
      within,
      feel: { give: 20, breakAt: 60, snapMs: 20 },
    })
    const drag = (x: number) => ({ ...(operation(x, 0) as object), source: { element } }) as never
    pullOut.apply(drag(-30))
    expect(element.dataset.pull).toBe("taut")
    expect(element.style.getPropertyValue("--pull-x")).toBe("-1.00")
    pullOut.apply(drag(-70))
    expect(element.dataset.pull).toBe("snapping")
    expect(element.style.getPropertyValue("--pull-snap-duration")).toBe("20ms")
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(element.dataset.pull).toBe("free")
  })

  it("holds a drag from the keyboard to the list", () => {
    const { pullOut } = modifier()
    expect(pullOut.apply(operation(-500, 0, true))).toEqual({ x: 0, y: 0 })
  })

  it("starts each drag held again", () => {
    const { pullOut, emit } = modifier()
    pullOut.apply(operation(-70, 0))
    emit("dragend")
    emit("dragstart")
    expect(pullOut.apply(operation(-30, 0)).x).toBeCloseTo(-12)
  })

  it("leaves nothing on its element when the drop still asks for a transform", () => {
    const { manager, emit } = managed()
    const element = document.createElement("div")
    const pullOut = new PullOut(manager as never, {
      element: list,
      within,
      feel: { give: 20, breakAt: 60, snapMs: 20 },
    })
    const drag = (x: number) => ({ ...(operation(x, 0) as object), source: { element } }) as never
    pullOut.apply(drag(-30))
    emit("dragend")
    expect(pullOut.apply(drag(-30))).toEqual({ x: -30, y: 0 })
    expect(element.dataset.pull).toBeUndefined()
    expect(element.style.getPropertyValue("--pull-tension")).toBe("")
  })
})
