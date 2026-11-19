import { describe, expect, it } from "vitest"

const context = describe

import { framingOf } from "./framing.js"
import {
  createLoupeWatch,
  levelAfterWheel,
  levelLabel,
  loupeIdle,
  loupeMargin,
  loupeRange,
  loupeShown,
  loupeSize,
  loupeWheelScript,
  loupeStep,
  parsePageLoupe,
  regionAround,
  shownLevel,
  spaceOf,
  type LoupeInput,
  type PageLoupeNotice,
} from "./loupe.js"

const run = (...inputs: LoupeInput[]) => inputs.reduce(loupeStep, loupeIdle)

describe("the levels a loupe shows", () => {
  it("run from what the page is drawn at to twice that, in the page's real size", () => {
    expect(loupeRange(0.713)).toEqual({ min: 0.713, max: 1.426 })
    expect(loupeRange(1)).toEqual({ min: 1, max: 2 })
  })

  it("start at the most, where nothing was kept", () => {
    expect(shownLevel(Infinity, 0.713)).toBeCloseTo(1.426)
    expect(shownLevel(Number.NaN, 0.5)).toBe(1)
  })

  it("never stretch the picture past twice its pixels, nor shrink it below the drawn size", () => {
    for (const drawn of [0.3, 0.713, 1]) {
      for (const level of [0.1, 0.5, 1, 1.4, 3, 4]) {
        const shown = shownLevel(level, drawn)
        // Levels over drawn are the picture's stretch: 1 is a crop, 2 its most.
        expect(shown / drawn).toBeGreaterThanOrEqual(1 - 1e-9)
        expect(shown / drawn).toBeLessThanOrEqual(2 + 1e-9)
      }
    }
  })

  it("snap to 100% where it's near and in range, and not where it isn't", () => {
    expect(shownLevel(1.02, 0.713)).toBe(1)
    expect(shownLevel(0.98, 0.713)).toBe(1)
    expect(shownLevel(1.1, 0.713)).toBeCloseTo(1.1)
    // A page drawn at half its size tops out at 100%, which is its own limit.
    expect(shownLevel(5, 0.5)).toBe(1)
    // 100% is under what's drawn here: never shown.
    expect(shownLevel(1, 1.2)).toBeCloseTo(1.2)
  })

  it("change with the wheel, up magnifying, held within the range", () => {
    const up = levelAfterWheel(1, -100, 0.713)
    expect(up).toBeGreaterThan(1)
    expect(levelAfterWheel(1, 100, 0.713)).toBeLessThan(1)
    expect(levelAfterWheel(1, -100000, 0.713)).toBeCloseTo(1.426)
    expect(levelAfterWheel(1, 100000, 0.713)).toBeCloseTo(0.713)
  })

  it("are labelled in the page's real size", () => {
    expect(levelLabel(1)).toBe("100%")
    expect(levelLabel(1.426)).toBe("143%")
  })
})

describe("the part of the page a loupe pictures", () => {
  const bounds = { width: 1024, height: 800 }

  it("is the loupe's own view with a margin, centred on the pointer", () => {
    const region = regionAround({ x: 500, y: 400 }, 2, bounds)
    const side = (loupeSize / 2) * loupeMargin
    expect(region).toEqual({ x: 500 - side / 2, y: 400 - side / 2, width: side, height: side })
  })

  it("is moved, not cut, to stay inside the page's view", () => {
    const corner = regionAround({ x: 2, y: 3 }, 2, bounds)
    expect(corner.x).toBe(0)
    expect(corner.y).toBe(0)
    expect(corner.width).toBeCloseTo((loupeSize / 2) * loupeMargin)
    const far = regionAround({ x: 1020, y: 799 }, 2, bounds)
    expect(far.x + far.width).toBe(1024)
    expect(far.y + far.height).toBe(800)
  })

  it("is the whole view where that's smaller", () => {
    expect(regionAround({ x: 5, y: 5 }, 1, { width: 100, height: 80 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    })
  })
})

describe("where a point is in a live page", () => {
  const viewer = { width: 730, height: 641 }

  context("a desktop's, zoomed out to fit its viewer", () => {
    const framing = framingOf("desktop", viewer.width, viewer.height)
    const zoom = 0.7128
    const space = spaceOf("desktop", framing, viewer, zoom * 0.9)

    it("is drawn at its framing's scale, over a page 1024 wide", () => {
      expect(space.drawn).toBeCloseTo(0.713, 2)
      expect(space.bounds.width).toBe(1024)
    })

    it("takes a point of the view, in the app's zoom, to the page and the viewer", () => {
      const page = space.page({ x: 100 * zoom * 0.9, y: 50 * zoom * 0.9 })
      expect(page.x).toBeCloseTo(100)
      expect(page.y).toBeCloseTo(50)
      expect(space.host(page)).toEqual({ x: 100 * space.drawn, y: 50 * space.drawn })
    })

    it("covers a part of the page in whole pixels of the view, and reads it back", () => {
      const rect = space.view({ x: 10.3, y: 20.6, width: 50, height: 50 })
      for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true)
      const back = space.unview(rect)
      expect(back.x).toBeLessThanOrEqual(10.3)
      expect(back.x + back.width).toBeGreaterThanOrEqual(60.3)
      expect(back.y).toBeLessThanOrEqual(20.6)
      expect(back.y + back.height).toBeGreaterThanOrEqual(70.6)
    })
  })

  context("a phone's, in its own pixels, scaled whole into its viewer", () => {
    const framing = framingOf("phone", viewer.width, viewer.height)!
    // Whatever zoom the app has, a phone's view is its own pixels.
    const space = spaceOf("phone", framing, viewer, 0.37)

    it("keeps view pixels and page pixels one for one, and finds the page where the phone sits", () => {
      expect(space.page({ x: 120, y: 300 })).toEqual({ x: 120, y: 300 })
      expect(space.host({ x: 0, y: 0 })).toEqual({ x: framing.left, y: framing.top })
      expect(space.host({ x: 390, y: 0 }).x).toBeCloseTo(framing.left + 390 * framing.scale)
      expect(space.drawn).toBe(framing.scale)
      expect(space.bounds).toEqual({ width: 390, height: 844 })
    })
  })

  context("a page that fills its viewer", () => {
    const space = spaceOf("desktop", undefined, viewer, 1)

    it("is drawn at its own size from the viewer's corner", () => {
      expect(space.drawn).toBe(1)
      expect(space.bounds).toEqual(viewer)
      expect(space.host({ x: 7, y: 9 })).toEqual({ x: 7, y: 9 })
    })
  })
})

describe("when a loupe shows", () => {
  it("is while Alt is held with the pointer on the page", () => {
    expect(loupeShown(run({ kind: "alt", down: true }))).toBe(false)
    expect(loupeShown(run({ kind: "alt", down: true }, { kind: "enter" }))).toBe(true)
    expect(
      loupeShown(run({ kind: "alt", down: true }, { kind: "enter" }, { kind: "alt", down: false })),
    ).toBe(false)
  })

  it("is while its tool is on with the pointer on the page", () => {
    expect(loupeShown(run({ kind: "toggle", on: true }))).toBe(false)
    expect(loupeShown(run({ kind: "toggle", on: true }, { kind: "enter" }))).toBe(true)
  })

  it("is turned off by Esc, by the tool again, and by the pointer leaving", () => {
    const on = run({ kind: "toggle", on: true }, { kind: "enter" })
    expect(loupeShown(loupeStep(on, { kind: "escape" }))).toBe(false)
    expect(loupeShown(loupeStep(on, { kind: "toggle", on: false }))).toBe(false)
    const left = loupeStep(on, { kind: "leave" })
    expect(left.toggled).toBe(false)
    expect(loupeShown(loupeStep(left, { kind: "enter" }))).toBe(false)
  })

  it("leaves Alt's loupe to Alt, not to Esc", () => {
    const held = run({ kind: "alt", down: true }, { kind: "enter" })
    expect(loupeShown(loupeStep(held, { kind: "escape" }))).toBe(true)
  })
})

describe("the watch over a live page's view", () => {
  const watched = () => {
    const told: Omit<PageLoupeNotice, "contentsId">[] = []
    const watch = createLoupeWatch((notice) => told.push(notice))
    return { watch, told }
  }

  it("tells when Alt shows it over the page, where it moves, and when it hides", () => {
    const { watch, told } = watched()
    watch.pointer(10, 20, false)
    expect(told).toEqual([])
    watch.pointer(11, 21, true)
    // A move that doesn't say Alt is held isn't saying it was let go.
    watch.pointer(15, 25, false)
    watch.alt(false)
    expect(told.map(({ shown, x, y }) => [shown, x, y])).toEqual([
      [true, 11, 21],
      [true, 15, 25],
      [false, 15, 25],
    ])
  })

  it("shows it for Alt pressed while the pointer rests", () => {
    const { watch, told } = watched()
    watch.pointer(30, 40, false)
    watch.alt(true)
    watch.alt(false)
    expect(told.map(({ shown }) => shown)).toEqual([true, false])
  })

  it("takes Esc while it shows, and only then", () => {
    const { watch, told } = watched()
    watch.pointer(1, 2, false)
    expect(watch.escape()).toBe(false)
    watch.toggle(true)
    expect(told.at(-1)).toMatchObject({ shown: true, toggled: true })
    expect(watch.escape()).toBe(true)
    expect(told.at(-1)).toMatchObject({ shown: false, toggled: false })
  })

  it("is turned off by the pointer leaving, and told so", () => {
    const { watch, told } = watched()
    watch.toggle(true)
    watch.pointer(1, 2, false)
    watch.leave()
    expect(told.at(-1)).toMatchObject({ shown: false, toggled: false })
  })
})

describe("a notice of the loupe", () => {
  it("is a view's id, two flags and a point", () => {
    const notice = { contentsId: 4, shown: true, toggled: false, x: 1.5, y: 2 }
    expect(parsePageLoupe(notice)).toEqual(notice)
  })

  it("is nothing otherwise", () => {
    const notice = { contentsId: 4, shown: true, toggled: false, x: 1, y: 2 }
    for (const bad of [
      null,
      "x",
      { ...notice, contentsId: 1.5 },
      { ...notice, shown: "yes" },
      { ...notice, x: Number.NaN },
      { ...notice, y: Infinity },
    ])
      expect(parsePageLoupe(bad)).toBeNull()
  })
})

describe("the wheel's script in the page", () => {
  // Run as the page does, in a document of its own, as an agent's would be.
  const frame = (): { page: Window; stop: () => void } => {
    const holder = document.createElement("iframe")
    document.body.append(holder)
    return { page: holder.contentWindow!, stop: () => holder.remove() }
  }
  const spin = (page: Window, deltaY: number, deltaMode = 0): WheelEvent => {
    const event = new (page as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent("wheel", {
      deltaY,
      deltaMode,
      cancelable: true,
      bubbles: true,
    })
    page.document.body.dispatchEvent(event)
    return event
  }

  it("takes the wheel while it shows, saying how far it turned since last asked", () => {
    const { page, stop } = frame()
    expect(
      (page as unknown as { eval: (code: string) => unknown }).eval(loupeWheelScript(true)),
    ).toBe(0)
    const taken = spin(page, 120)
    expect(taken.defaultPrevented).toBe(true)
    spin(page, -20)
    expect(
      (page as unknown as { eval: (code: string) => unknown }).eval(loupeWheelScript(true)),
    ).toBe(100)
    expect(
      (page as unknown as { eval: (code: string) => unknown }).eval(loupeWheelScript(true)),
    ).toBe(0)
    stop()
  })

  it("gives the wheel back to the page when it's off, and counts lines as pixels", () => {
    const { page, stop } = frame()
    const take = (on: boolean) =>
      (page as unknown as { eval: (code: string) => unknown }).eval(loupeWheelScript(on))
    take(true)
    expect(spin(page, 3, 1).defaultPrevented).toBe(true)
    expect(take(false)).toBe(48)
    expect(spin(page, 100).defaultPrevented).toBe(false)
    expect(take(true)).toBe(0)
    stop()
  })
})
