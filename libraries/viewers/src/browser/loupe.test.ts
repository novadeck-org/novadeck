import { describe, expect, it } from "vitest"

import { framingOf } from "./framing.js"
import {
  createLoupeWatch,
  heldAfter,
  levelLabel,
  loupeIdle,
  loupeLevel,
  loupeMargin,
  loupeShown,
  loupeSize,
  loupeStep,
  parsePageLoupe,
  regionAround,
  spaceOf,
  type LoupeInput,
  type PageLoupeNotice,
} from "./loupe.js"

const context = describe
const run = (...inputs: LoupeInput[]) => inputs.reduce(loupeStep, loupeIdle)
const alt = { kind: "keys", alt: true, other: false } as const
const none = { kind: "keys", alt: false, other: false } as const
const free = { alt: false, other: false }
const held = { alt: true, other: false }

describe("the level a loupe shows", () => {
  it("is twice what the page is drawn at, in the page's real size", () => {
    expect(loupeLevel(0.713)).toBeCloseTo(1.426)
    expect(loupeLevel(1)).toBe(2)
  })

  it("never stretches the picture past twice its pixels", () => {
    for (const drawn of [0.3, 0.713, 1, 1.4]) expect(loupeLevel(drawn) / drawn).toBe(2)
  })

  it("is labelled in the page's real size", () => {
    expect(levelLabel(1)).toBe("100%")
    expect(levelLabel(loupeLevel(0.713))).toBe("143%")
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

  context("at either size, the view is as big as it's drawn and the page zoomed in it", () => {
    for (const size of ["desktop", "phone"] as const) {
      const framing = framingOf(size, viewer.width, viewer.height)
      // The view's zoom, as the app's own (90%) times the page's to fit its framing.
      const per = (framing?.scale ?? 1) * 0.9
      const space = spaceOf(framing, viewer, per)

      it(`takes a point of a ${size}'s view to the page and the viewer`, () => {
        const page = space.page({ x: 100 * per, y: 50 * per })
        expect(page.x).toBeCloseTo(100)
        expect(page.y).toBeCloseTo(50)
        const at = space.host(page)
        expect(at.x).toBeCloseTo((framing?.left ?? 0) + 100 * space.drawn)
        expect(at.y).toBeCloseTo((framing?.top ?? 0) + 50 * space.drawn)
        expect(space.drawn).toBe(framing?.scale ?? 1)
      })

      it(`covers a part of a ${size}'s page in whole pixels of its view, and reads it back`, () => {
        const rect = space.view({ x: 10.3, y: 20.6, width: 50, height: 50 })
        for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true)
        const back = space.unview(rect)
        expect(back.x).toBeLessThanOrEqual(10.3)
        expect(back.x + back.width).toBeGreaterThanOrEqual(60.3)
        expect(back.y).toBeLessThanOrEqual(20.6)
        expect(back.y + back.height).toBeGreaterThanOrEqual(70.6)
      })
    }
  })

  it("centres a loupe on the pointer for a phone at app zoom 80% and 125%, at fit, zoomed and mid-ease", () => {
    // A phone's view as `frame` makes it: its drawn size times the app's zoom in device pixels,
    // its page zoomed by the drawn scale times the app's; mid-ease it's drawn at the larger
    // scale and shown at `shownScale`.
    const phone = (scale: number, shownScale: number, app: number) => {
      const framing = { width: 390, height: 844, scale: shownScale, left: 40, top: 20 }
      const space = spaceOf(framing, viewer, scale * app)
      // The pointer at a place the viewer shows: where the phone's pixel (200, 300) is drawn.
      const pointerHost = { x: 40 + 200 * shownScale, y: 20 + 300 * shownScale }
      // The view's own pixels there, which the app's pointer events speak: the view is `scale`
      // drawn, then shown at `shownScale` by a transform, so a view point is the page's times
      // `scale` times the app's zoom.
      const pointerView = { x: 200 * scale * app, y: 300 * scale * app }
      const lens = space.host(space.page(pointerView))
      return { lens, pointerHost }
    }
    for (const app of [0.8, 1.25]) {
      for (const [scale, shown] of [
        [0.47, 0.47],
        [1.3, 1.3],
        [1.3, 0.9],
      ] as const) {
        const { lens, pointerHost } = phone(scale, shown, app)
        expect(lens.x).toBeCloseTo(pointerHost.x)
        expect(lens.y).toBeCloseTo(pointerHost.y)
      }
    }
  })

  context("a page that fills its viewer", () => {
    const space = spaceOf(undefined, viewer, 1)

    it("is drawn at its own size from the viewer's corner", () => {
      expect(space.drawn).toBe(1)
      expect(space.bounds).toEqual(viewer)
      expect(space.host({ x: 7, y: 9 })).toEqual({ x: 7, y: 9 })
    })
  })
})

describe("when a loupe shows", () => {
  it("is while Alt is held alone with the pointer on the page", () => {
    expect(loupeShown(run(alt))).toBe(false)
    expect(loupeShown(run(alt, { kind: "enter" }))).toBe(true)
    expect(loupeShown(run(alt, { kind: "enter" }, none))).toBe(false)
  })

  it("isn't for Alt with Ctrl, Meta or Shift, as AltGr types letters", () => {
    expect(loupeShown(run({ kind: "keys", alt: true, other: true }, { kind: "enter" }))).toBe(false)
  })

  it("is while its tool is on with the pointer on the page", () => {
    expect(loupeShown(run({ kind: "toggle", on: true }))).toBe(false)
    expect(loupeShown(run({ kind: "toggle", on: true }, { kind: "enter" }))).toBe(true)
  })

  it("is turned off by Esc, by the tool again, by the pointer leaving, and by the viewer going away", () => {
    const on = run({ kind: "toggle", on: true }, { kind: "enter" })
    expect(loupeShown(loupeStep(on, { kind: "escape" }))).toBe(false)
    expect(loupeShown(loupeStep(on, { kind: "toggle", on: false }))).toBe(false)
    for (const gone of [{ kind: "leave" }, { kind: "away" }] as const) {
      const left = loupeStep(on, gone)
      expect(left.toggled).toBe(false)
      expect(left.over).toBe(false)
      expect(loupeShown(loupeStep(left, { kind: "enter" }))).toBe(false)
    }
  })
})

describe("what the keys and the pointer say of Alt", () => {
  it("is Alt held when its key went down, and let go when it went up", () => {
    expect(heldAfter({ type: "keyDown", key: "Alt", alt: true })).toEqual(held)
    expect(heldAfter({ type: "keyUp", key: "Alt", alt: false })).toEqual(free)
  })

  it("is Alt with another modifier where Ctrl, Meta or Shift comes with it", () => {
    expect(heldAfter({ type: "keyDown", key: "Alt", alt: true, control: true })).toEqual({
      alt: true,
      other: true,
    })
    expect(heldAfter({ type: "keyDown", key: "a", alt: true, shift: true })).toEqual({
      alt: true,
      other: true,
    })
  })

  it("is nothing held once AltGr goes up, whatever Windows reported it as", () => {
    expect(heldAfter({ type: "keyUp", key: "AltGraph", alt: true, control: true })).toEqual(free)
  })

  it("is what another key carries, so a lost Alt key up is let go by the next key", () => {
    expect(heldAfter({ type: "keyDown", key: "a", alt: false })).toEqual(free)
  })
})

describe("the watch over a live page's view", () => {
  const watched = () => {
    const told: Omit<PageLoupeNotice, "contentsId">[] = []
    const guards: boolean[] = []
    const watch = createLoupeWatch(
      (notice) => told.push(notice),
      (on) => guards.push(on),
    )
    return { watch, told, guards }
  }

  it("tells when Alt shows it over the page, where it moves, and when it hides", () => {
    const { watch, told } = watched()
    watch.pointer(10, 20)
    expect(told).toEqual([])
    watch.keys(held)
    watch.pointer(15, 25)
    watch.pointer(16, 26)
    expect(told.map(({ shown, x, y }) => [shown, x, y])).toEqual([
      [true, 10, 20],
      [true, 15, 25],
      [true, 16, 26],
    ])
  })

  it("shows it for Alt pressed while the pointer rests", () => {
    const { watch, told } = watched()
    watch.pointer(30, 40)
    watch.keys(held)
    watch.keys(free)
    expect(told.map(({ shown }) => shown)).toEqual([true, false])
  })

  it("takes Esc only while its tool is on, not for Alt's loupe nor with nothing showing", () => {
    const { watch, told } = watched()
    watch.keys(held)
    watch.pointer(1, 2)
    expect(watch.escape()).toBe(false)
    expect(told.at(-1)).toMatchObject({ shown: true })
    watch.keys(free)
    watch.toggle(true)
    expect(told.at(-1)).toMatchObject({ shown: true, toggled: true })
    expect(watch.escape()).toBe(true)
    expect(told.at(-1)).toMatchObject({ shown: false, toggled: false })
    expect(watch.escape()).toBe(false)
  })

  it("is turned off by the pointer leaving, and told so, and by the viewer going away", () => {
    const { watch, told } = watched()
    watch.toggle(true)
    watch.pointer(1, 2)
    watch.leave()
    expect(told.at(-1)).toMatchObject({ shown: false, toggled: false })
    watch.toggle(true)
    watch.pointer(1, 2)
    expect(watch.state().over).toBe(true)
    watch.away()
    expect(watch.state()).toMatchObject({ over: false, toggled: false })
    expect(told.at(-1)).toMatchObject({ shown: false, toggled: false })
  })

  it("keeps the window's menu bar while the pointer is over the page or Alt is down", () => {
    const { watch, guards } = watched()
    watch.pointer(1, 2)
    watch.pointer(2, 3)
    expect(guards).toEqual([true])
    watch.keys(held)
    watch.leave()
    // Alt still down: the menu bar's toggle comes on its key up.
    expect(guards).toEqual([true])
    watch.keys(free)
    expect(guards).toEqual([true, false])
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
