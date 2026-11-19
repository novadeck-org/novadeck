import "../browser.css"
import { afterEach, describe, expect, it, vi } from "vitest"

import { mountBrowser, type BrowserOptions } from "../browser.js"
import { loupeFrameMs } from "./loupe-view.js"
import { pageLoupeMessage, type PageLoupeNotice } from "./loupe.js"

const panes: HTMLElement[] = []
const viewers: { destroy: () => void }[] = []
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
// What the loupe is: twice the page's drawn size, 400 wide of 1024, in its real size.
const twice = `${Math.round((400 / 1024) * 2 * 100)}%`

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

  it("shows under the pointer while Alt is held, at twice what the picture is drawn at", async () => {
    const { pane, scroll, at } = mounted()
    const image = pane.querySelector("img")!
    await image.decode()
    expect(lens(pane).hidden).toBe(true)
    pointer(scroll, "pointermove", at.x, at.y)
    expect(lens(pane).hidden).toBe(true)
    pointer(scroll, "pointermove", at.x, at.y, true)
    expect(lens(pane).hidden).toBe(false)
    expect(level(pane)).toBe(twice)
    expect(lens(pane).querySelector("img")!.getAttribute("src")).toBe(picture)
    pointer(scroll, "pointermove", at.x, at.y, false)
    expect(lens(pane).hidden).toBe(true)
  })

  it("follows Alt pressed and let go with the pointer at rest, and the pointer leaving", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    pointer(scroll, "pointermove", at.x, at.y)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))
    expect(lens(pane).hidden).toBe(false)
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }))
    expect(lens(pane).hidden).toBe(true)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))
    pointer(scroll, "pointerleave", at.x, at.y)
    expect(lens(pane).hidden).toBe(true)
  })

  it("is turned on by the tool, tells so, and goes off on Esc or the pointer leaving", async () => {
    const toggles: boolean[] = []
    const { pane, viewer, scroll, at } = mounted({ loupe: (on) => toggles.push(on) })
    await pane.querySelector("img")!.decode()
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

  it("takes Esc only while the tool is on, not from Alt's loupe", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    pointer(scroll, "pointermove", at.x, at.y, true)
    expect(lens(pane).hidden).toBe(false)
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(lens(pane).hidden).toBe(false)
  })

  it("isn't for Alt with Ctrl, Meta or Shift, as AltGr types letters", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    scroll.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: at.x,
        clientY: at.y,
        altKey: true,
        ctrlKey: true,
        bubbles: true,
      }),
    )
    expect(lens(pane).hidden).toBe(true)
  })

  it("keeps the window's menu bar from an Alt over it, and lets go of a lost Alt on blur", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    const away = new KeyboardEvent("keydown", { key: "Alt", altKey: true, cancelable: true })
    window.dispatchEvent(away)
    expect(away.defaultPrevented).toBe(false)
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }))
    pointer(scroll, "pointermove", at.x, at.y)
    const press = new KeyboardEvent("keydown", { key: "Alt", altKey: true, cancelable: true })
    window.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect(lens(pane).hidden).toBe(false)
    const release = new KeyboardEvent("keyup", { key: "Alt", cancelable: true })
    window.dispatchEvent(release)
    expect(release.defaultPrevented).toBe(true)
    expect(lens(pane).hidden).toBe(true)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))
    expect(lens(pane).hidden).toBe(false)
    window.dispatchEvent(new Event("blur"))
    expect(lens(pane).hidden).toBe(true)
  })

  it("stays inside the viewer's box, not over the pane around it", () => {
    const { pane } = mounted()
    const clip = pane.querySelector<HTMLElement>(".browser-loupe-clip")!
    expect(getComputedStyle(clip).overflow).toBe("hidden")
    expect(clip.parentElement).toBe(pane.querySelector(".browser-viewer"))
  })

  it("goes when the viewer is kept out of sight, with no pointer leaving", async () => {
    const { pane, viewer, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    pointer(scroll, "pointermove", at.x, at.y, true)
    expect(lens(pane).hidden).toBe(false)
    viewer.muted(true)
    expect(lens(pane).hidden).toBe(true)
  })

  it("is placed with its centre on the pointer", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    pointer(scroll, "pointermove", at.x, at.y, true)
    const rim = lens(pane).getBoundingClientRect()
    expect(rim.left + rim.width / 2).toBeCloseTo(at.x, 0)
    expect(rim.top + rim.height / 2).toBeCloseTo(at.y, 0)
  })

  it("lets the wheel scroll the snapshot: the level is fixed", async () => {
    const { pane, scroll, at } = mounted()
    await pane.querySelector("img")!.decode()
    pointer(scroll, "pointermove", at.x, at.y, true)
    const event = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true })
    scroll.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(level(pane)).toBe(twice)
  })
})

describe("the loupe over a live page", () => {
  const pictures = (src = "data:image/png;base64,AAAA") => {
    const asked: { page: number; rect: { x: number; y: number; width: number; height: number } }[] =
      []
    const held: [number, boolean, boolean][] = []
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
        hold: vi.fn<(page: number, on: boolean, away?: boolean) => Promise<boolean>>(
          async (page, on, away) => {
            held.push([page, on, away === true])
            return true
          },
        ),
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

  it("asks less often while the pointer rests, and picks the pace up again on a move", async () => {
    vi.useFakeTimers()
    const { loupe, asked } = pictures()
    mounted(loupe)
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    await vi.advanceTimersByTimeAsync(2000)
    // Still for most of it: about 5 a second, not 30.
    expect(asked.length).toBeLessThan(20)
    const resting = asked.length
    tell({ shown: true, toggled: false, x: 130, y: 120 })
    await vi.advanceTimersByTimeAsync(loupeFrameMs * 3)
    expect(asked.length).toBeGreaterThan(resting)
  })

  it("is twice what the page is drawn at, and tells the tool going off", () => {
    const { loupe } = pictures()
    const toggles: boolean[] = []
    const { pane } = mounted(loupe, { loupe: (on) => toggles.push(on) })
    tell({ shown: true, toggled: true, x: 100, y: 120 })
    expect(toggles).toEqual([true])
    expect(level(pane)).toBe(twice)
    tell({ shown: false, toggled: false, x: 100, y: 120 })
    expect(toggles).toEqual([true, false])
  })

  it("leaves the page its wheel: nothing is run in the page", async () => {
    const { loupe } = pictures()
    const { page } = mounted(loupe)
    const scripts: string[] = []
    Object.assign(page, { executeJavaScript: async (code: string) => scripts.push(code) })
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    await vi.waitFor(() => expect(loupe.look).toHaveBeenCalled())
    expect(scripts).toEqual([])
  })

  it("goes, and tells the app the viewer is away, when it is kept out of sight", async () => {
    const { loupe, held } = pictures()
    const { pane, viewer } = mounted(loupe)
    tell({ shown: true, toggled: false, x: 100, y: 120 })
    viewer.muted(true)
    expect(lens(pane).hidden).toBe(true)
    await vi.waitFor(() => expect(held.at(-1)).toEqual([7, false, true]))
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
        [7, true, false],
        [7, false, false],
      ]),
    )
  })

  it("goes through once the page's view is there, for a tool pressed while the page rested", async () => {
    const { loupe, held } = pictures()
    const toggles: boolean[] = []
    const { viewer, page } = mounted(loupe, { loupe: (on) => toggles.push(on) })
    Object.assign(page, {
      getWebContentsId: () => {
        throw new Error("not attached")
      },
    })
    viewer.loupe(true)
    expect(toggles).toEqual([true])
    expect(held).toEqual([])
    Object.assign(page, { getWebContentsId: () => 7 })
    page.dispatchEvent(new Event("dom-ready"))
    await vi.waitFor(() => expect(held).toEqual([[7, true, false]]))
  })

  it("has no tool to turn on where the app can't follow the pointer", () => {
    const toggles: boolean[] = []
    const { pane, viewer } = mounted(undefined, { loupe: (on) => toggles.push(on) })
    viewer.loupe(true)
    expect(toggles).toEqual([])
    expect(pane.querySelector(".browser-loupe")).toBeNull()
  })

  it("reads a phone's view in its drawn pixels, centred on the pointer", async () => {
    const { loupe, asked } = pictures()
    const { pane } = mounted(loupe, {}, "phone")
    tell({ shown: true, toggled: false, x: 195, y: 400 })
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    const { rect } = asked[0]!
    expect(rect.x + rect.width / 2).toBeCloseTo(195, -1)
    expect(rect.y + rect.height / 2).toBeCloseTo(400, -1)
    expect(lens(pane).hidden).toBe(false)
  })
})
