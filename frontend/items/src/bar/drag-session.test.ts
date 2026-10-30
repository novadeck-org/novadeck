import { describe, expect, it } from "../test"
import { createDragSession, pageHitTest, type HitTest } from "./drag-session"

const canvas = { canvas: { x: 120, y: 48 } }

// A page with terminal 02's window on the left, its taskbar along its bottom, and free
// space on the right.
const page: HitTest = (x, y) =>
  x < 100 ? { over: "02", onBar: y > 90 } : { over: null, onBar: false }

describe("a drag off a taskbar", () => {
  it("says which terminal's window, and whether its bar, is under the pointer", () => {
    const session = createDragSession(page)
    session.start({ from: "01", name: "hero.png", undocks: true })
    session.move(50, 95)
    expect(session.drag.getSnapshot()).toMatchObject({ over: "02", onBar: true, place: null })
  })

  it("asks the views where its window would open over their free space", () => {
    const session = createDragSession(page)
    session.offer(() => null)
    const withdraw = session.offer((x) => (x > 100 ? canvas : null))
    session.start({ from: "01", name: "hero.png", undocks: true })
    session.move(150, 10)
    expect(session.drag.getSnapshot()?.place).toBe(canvas)
    withdraw()
    session.move(160, 10)
    expect(session.drag.getSnapshot()?.place).toBeNull()
  })

  it("opens no window for what doesn't undock", () => {
    const session = createDragSession(page)
    session.offer(() => canvas)
    session.start({ from: "01", name: "", undocks: false })
    session.move(150, 10)
    expect(session.drag.getSnapshot()?.place).toBeNull()
  })

  it("tells nobody of a move that changes nothing", () => {
    const session = createDragSession(page)
    session.start({ from: "01", name: "hero.png", undocks: false })
    session.move(150, 10)
    let told = 0
    session.drag.subscribe(() => (told += 1))
    session.move(170, 30)
    expect(told).toBe(0)
  })

  it("ends where the pointer left it, or nowhere when cancelled", () => {
    const session = createDragSession(page)
    session.start({ from: "01", name: "hero.png", undocks: true })
    session.move(50, 95)
    expect(session.end()).toMatchObject({ over: "02", onBar: true })
    expect(session.drag.getSnapshot()).toBeNull()
    session.start({ from: "01", name: "hero.png", undocks: true })
    expect(session.end(true)).toBeNull()
  })
})

describe("what the page has under a point", () => {
  // Terminal 02's window with its taskbar, under terminal 01's Canvas sheet.
  const layered = (withSheet: boolean): Element[] => {
    const window = document.createElement("section")
    window.dataset.terminal = "02"
    const bar = document.createElement("div")
    bar.dataset.taskbar = ""
    window.append(bar)
    const sheet = document.createElement("div")
    sheet.dataset.companionOf = "01"
    const text = document.createElement("p")
    sheet.append(text)
    document.body.append(window, sheet)
    return withSheet ? [text, sheet, bar, window, document.body] : [bar, window, document.body]
  }
  const pointAt = (elements: Element[]): void => {
    document.elementsFromPoint = () => elements
  }

  it("is a terminal's taskbar where nothing covers it", () => {
    pointAt(layered(false))
    expect(pageHitTest(10, 10)).toEqual({ over: "02", onBar: true })
  })

  it("is the sheet's own terminal, not the bar it covers", () => {
    pointAt(layered(true))
    expect(pageHitTest(10, 10)).toEqual({ over: "01", onBar: false })
  })
})
