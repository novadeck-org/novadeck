import "../browser.css"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mountBrowser, type BrowserOptions } from "../browser.js"
import { loupeFrameMs } from "./loupe-view.js"
import { pageLoupeMessage, type PageLoupeNotice } from "./loupe.js"

const panes: HTMLElement[] = []
const viewers: { destroy: () => void }[] = []
beforeEach(() => localStorage.removeItem("novadeck.page-loupe-level"))
afterEach(() => {
  vi.useRealTimers()
  // Each listens to its window's keys and messages, past its pane.
  for (const viewer of viewers.splice(0)) viewer.destroy()
  for (const pane of panes.splice(0)) pane.remove()
})

const paneIn = (): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 400px"
  document.body.append(pane)
  panes.push(pane)
  return pane
}

const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="white"/></svg>')}`

const lens = (pane: HTMLElement): HTMLElement => pane.querySelector<HTMLElement>(".browser-loupe")!
const level = (pane: HTMLElement): string =>
  pane.querySelector(".browser-loupe-level")!.textContent ?? ""
const pointer = (target: Element, type: string, x: number, y: number, altKey = false): void => {
  target.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, altKey, bubbles: true, pointerType: "mouse" }),
  )
}

describe("the loupe over a snapshot", () => {
  const mounted = (on: BrowserOptions["on"] = {}) => {
    const pane = paneIn()
    const viewer = mountBrowser(pane, {
      content: { url: "http://localhost:5173/" },
      label: "page",
      live: false,
      snapshot: { src: picture, alt: "page" },
      partition: "pages",
      on,
    })
    viewers.push(viewer)
    const scroll = pane.querySelector<HTMLElement>(".browser-snapshot")!
    const box = scroll.getBoundingClientRect()
    return { pane, viewer, scroll, at: { x: box.left + 100, y: box.top + 80 } }
  }

  it("shows under the pointer while Alt is held, as big as the page's real size allows", () => {
    const { pane, scroll, at } = mounted()
    expect(lens(pane).hidden).toBe(true)
    pointer(scroll, "pointermove", at.x, at.y)
    expect(lens(pane).hidden).toBe(true)
    pointer(scroll, "pointermove", at.x, at.y, true)
    expect(lens(pane).hidden).toBe(false)
    // The snapshot is a page 1024 wide drawn 400 wide: its most is twice that, 78%.
    expect(level(pane)).toBe(`${Math.round((400 / 1024) * 2 * 100)}%`)
    const image = lens(pane).querySelector("img")!
    expect(image.getAttribute("src")).toBe(picture)
    pointer(scroll, "pointermove", at.x, at.y, false)
    expect(lens(pane).hidden).toBe(true)
  })

  it("follows Alt pressed and let go with the pointer at rest, and the pointer leaving", () => {
    const { pane, scroll, at } = mounted()
    pointer(scroll, "pointermove", at.x, at.y)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }))
    expect(lens(pane).hidden).toBe(false)
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }))
    expect(lens(pane).hidden).toBe(true)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }))
    pointer(scroll, "pointerleave", at.x, at.y)
    expect(lens(pane).hidden).toBe(true)
  })

  it("is turned on by the tool, tells so, and goes off on Esc or the pointer leaving", () => {
    const toggles: boolean[] = []
    const { pane, viewer, scroll, at } = mounted({ loupe: (on) => toggles.push(on) })
    viewer.loupe(true)
    expect(toggles).toEqual([true])
    pointer(scroll, "pointermove", at.x, at.y)
    expect(lens(pane).hidden).toBe(false)
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(lens(pane).hidden).toBe(true)
    expect(toggles).toEqual([true, false])
    viewer.loupe(true)
    pointer(scroll, "pointermove", at.x, at.y)
    pointer(scroll, "pointerleave", at.x, at.y)
    expect(toggles).toEqual([true, false, true, false])
    // Esc with no loupe showing is left to the page.
    const idle = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true })
    window.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)
  })

  it("changes level with the wheel within its range, snapping at 100%, and keeps it for next time", () => {
    const { pane, scroll, at } = mounted()
    pointer(scroll, "pointermove", at.x, at.y, true)
    const wheel = (deltaY: number): WheelEvent => {
      const event = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true })
      scroll.dispatchEvent(event)
      return event
    }
    const most = level(pane)
    expect(wheel(-300).defaultPrevented).toBe(true)
    expect(level(pane)).toBe(most)
    wheel(100)
    expect(Number.parseInt(level(pane))).toBeLessThan(Number.parseInt(most))
    wheel(100000)
    expect(level(pane)).toBe(`${Math.round((400 / 1024) * 100)}%`)
    // Kept: a loupe mounted later starts there.
    const next = mounted()
    pointer(next.scroll, "pointermove", next.at.x, next.at.y, true)
    expect(level(next.pane)).toBe(`${Math.round((400 / 1024) * 100)}%`)
  })

  it("lets the wheel scroll the snapshot while it isn't showing", () => {
    const { scroll, at } = mounted()
    pointer(scroll, "pointermove", at.x, at.y)
    const event = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true })
    scroll.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it("is placed with its centre on the pointer", () => {
    const { pane, scroll, at } = mounted()
    pointer(scroll, "pointermove", at.x, at.y, true)
    const rim = lens(pane).getBoundingClientRect()
    expect(rim.left + rim.width / 2).toBeCloseTo(at.x, 0)
    expect(rim.top + rim.height / 2).toBeCloseTo(at.y, 0)
  })
})

describe("the loupe over a live page", () => {
  // What the wheel turned in the page, as its script says when asked, and every script run.
  const spun: number[] = []
  const scripts: string[] = []
  beforeEach(() => {
    spun.length = 0
    scripts.length = 0
  })
  const pictures = (src = "data:image/png;base64,AAAA") => {
    const asked: { page: number; rect: { x: number; y: number; width: number; height: number } }[] =
      []
    const held: [number, boolean][] = []
    return {
      asked,
      held,
      loupe: {
        look: vi.fn<(page: number, rect: (typeof asked)[number]["rect"]) => Promise<string>>(
          async (page, rect) => {
            asked.push({ page, rect })
            return src
          },
        ),
        hold: vi.fn<(page: number, on: boolean) => Promise<boolean>>(async (page, on) => {
          held.push([page, on])
          return true
        }),
      },
    }
  }
  const mounted = (
    loupe: BrowserOptions["loupe"],
    on: BrowserOptions["on"] = {},
    size?: "phone",
  ) => {
    const pane = paneIn()
    const viewer = mountBrowser(pane, {
      content: { url: "http://localhost:5173/" },
      label: "page",
      live: true,
      partition: "pages",
      ...(loupe && { loupe }),
      ...(size && { size }),
      on,
    })
    viewers.push(viewer)
    const page = pane.querySelector("webview") as HTMLElement & Record<string, unknown>
    Object.assign(page, {
      getWebContentsId: () => 7,
      getURL: () => "http://localhost:5173/",
      canGoBack: () => false,
      canGoForward: () => false,
      setAudioMuted: () => undefined,
      getZoomFactor: () => 0.9,
      setZoomFactor: () => undefined,
      executeJavaScript: async (code: string) => {
        scripts.push(code)
        return spun.splice(0).reduce((sum, turned) => sum + turned, 0)
      },
    })
    return { pane, viewer, page }
  }
  const tell = (notice: Omit<PageLoupeNotice, "contentsId"> & { contentsId?: number }): void => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: pageLoupeMessage, contentsId: 7, ...notice },
        source: window,
      }),
    )
  }

  it("shows where the main process says the pointer is, over a picture of the page there", async () => {
    const { loupe, asked } = pictures()
    const { pane } = mounted(loupe)
    // The page is 1024 wide in a 400 viewer: its view is zoomed to 0.39 (device pixels the same).
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    expect(lens(pane).hidden).toBe(false)
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    const { page, rect } = asked[0]!
    expect(page).toBe(7)
    for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true)
    await vi.waitFor(() =>
      expect(lens(pane).querySelector("img")!.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      ),
    )
    tell({ shown: false, toggled: false, x: 100, y: 120 })
    expect(lens(pane).hidden).toBe(true)
  })

  it("asks for the next picture as the last lands, no faster than its cadence, and stops when hidden", async () => {
    vi.useFakeTimers()
    const { loupe, asked } = pictures()
    mounted(loupe)
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked.length).toBe(1)
    await vi.advanceTimersByTimeAsync(loupeFrameMs / 2)
    expect(asked.length).toBe(1)
    await vi.advanceTimersByTimeAsync(loupeFrameMs)
    expect(asked.length).toBe(2)
    tell({ shown: false, toggled: false, x: 100, y: 120 })
    const stopped = asked.length
    await vi.advanceTimersByTimeAsync(loupeFrameMs * 10)
    expect(asked.length).toBe(stopped)
  })

  it("changes level on the wheel the main process took, and tells the tool going off", async () => {
    const { loupe } = pictures()
    const toggles: boolean[] = []
    const { pane } = mounted(loupe, { loupe: (on) => toggles.push(on) })
    tell({ shown: true, toggled: true, x: 100, y: 120 })
    expect(toggles).toEqual([true])
    const most = Number.parseInt(level(pane))
    spun.push(100)
    await vi.waitFor(() => expect(Number.parseInt(level(pane))).toBeLessThan(most))
    tell({ shown: false, toggled: false, x: 100, y: 120 })
    expect(toggles).toEqual([true, false])
  })

  it("takes the wheel over the page while it shows, and gives it back when it hides", async () => {
    const { loupe } = pictures()
    mounted(loupe)
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    await vi.waitFor(() =>
      expect(scripts.some((code) => code.includes("state.on = true"))).toBe(true),
    )
    tell({ shown: false, toggled: false, x: 100, y: 120 })
    await vi.waitFor(() => expect(scripts.at(-1)).toContain("state.on = false"))
  })

  it("hears only its own view's notices", () => {
    const { loupe } = pictures()
    const { pane } = mounted(loupe)
    tell({ contentsId: 8, shown: true, toggled: false, x: 1, y: 1 })
    expect(lens(pane).hidden).toBe(true)
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: pageLoupeMessage, contentsId: 7, shown: 1 },
        source: window,
      }),
    )
    expect(lens(pane).hidden).toBe(true)
  })

  it("turns the tool's loupe on and off in the app's watch of the view", async () => {
    const { loupe, held } = pictures()
    const { viewer } = mounted(loupe)
    viewer.loupe(true)
    viewer.loupe(false)
    await vi.waitFor(() =>
      expect(held).toEqual([
        [7, true],
        [7, false],
      ]),
    )
  })

  it("has no tool to turn on where the app can't follow the pointer", () => {
    const toggles: boolean[] = []
    const { pane, viewer } = mounted(undefined, { loupe: (on) => toggles.push(on) })
    viewer.loupe(true)
    expect(toggles).toEqual([])
    expect(pane.querySelector(".browser-loupe")).toBeNull()
  })

  it("reads a phone's view in its own pixels, whatever zoom the app has", async () => {
    const { loupe, asked } = pictures()
    const { pane } = mounted(loupe, {}, "phone")
    tell({ shown: true, toggled: false, x: 195, y: 400 })
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    const { rect } = asked[0]!
    // Centred on the pointer, a phone's page pixel one for one with its view's.
    expect(rect.x + rect.width / 2).toBeCloseTo(195, -1)
    expect(rect.y + rect.height / 2).toBeCloseTo(400, -1)
    expect(lens(pane).hidden).toBe(false)
  })
})
