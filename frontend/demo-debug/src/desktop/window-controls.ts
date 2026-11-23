import type { Backend } from "@novadeck/core/port"

// How the desktop app's window holds its own controls, as the demo plays it: set into the
// header's start (`inset`, macOS), the same in full screen, where they leave the page, or at the
// header's top-right corner (`caption`, Windows' caption buttons); undefined for a window with
// its own title bar, as on Linux, or a browser.
export type DemoWindowControls = "inset" | "fullScreen" | "caption"

// Where macOS draws the buttons, in CSS pixels: as apps/desktop's main/window/controls.ts
// places them at the app's normal scale.
const left = 16
const width = 54
const size = 12
const colors = ["#ff5f57", "#febc2e", "#28c840"] as const

// Windows' caption buttons as Electron draws them at the normal scale: 46 pixels each, from the
// window's top, their symbols in the header's ink; the close button's hover is Electron's red,
// the others' the ink at a tenth, as it tints them against the page's ground.
const captionWidth = 46
const glyphs = [
  '<path d="M0 5.5h10"/>',
  '<rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/>',
  '<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>',
] as const
const closeHover = "#e81123"

// Takes away the buttons an earlier boot drew, and the page's word that it is the window's
// title bar.
export const clearDemoWindowControls = (page: Document = document): void => {
  page.querySelectorAll("[data-demo-window-controls]").forEach((each) => each.remove())
  delete page.documentElement.dataset.windowControls
}

// macOS's three lights, hidden until the page places them.
const drawLights = (page: Document, mode: DemoWindowControls): HTMLElement => {
  const lights = page.createElement("div")
  lights.dataset.demoWindowControls = mode
  lights.setAttribute("aria-hidden", "true")
  Object.assign(lights.style, {
    position: "fixed",
    left: `${left}px`,
    zIndex: "2147483647",
    display: "none",
    gap: `${(width - size * 3) / 2}px`,
    pointerEvents: "none",
  })
  for (const color of colors) {
    const light = page.createElement("span")
    Object.assign(light.style, {
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "50%",
      background: color,
      boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 0.2)",
    })
    lights.append(light)
  }
  return lights
}

// Windows' three caption buttons at the top-right corner, hidden until the page places them;
// they light up under the pointer as Windows' do, and take its clicks, as they would.
const drawCaption = (page: Document): HTMLElement => {
  const caption = page.createElement("div")
  caption.dataset.demoWindowControls = "caption"
  caption.setAttribute("aria-hidden", "true")
  Object.assign(caption.style, {
    position: "fixed",
    top: "0",
    right: "0",
    zIndex: "2147483647",
    display: "none",
    color: "var(--region-header-fg, var(--color-ink))",
  })
  glyphs.forEach((glyph, index) => {
    const button = page.createElement("span")
    const close = index === glyphs.length - 1
    Object.assign(button.style, {
      display: "grid",
      placeItems: "center",
      width: `${captionWidth}px`,
      height: "100%",
    })
    button.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">${glyph}</svg>`
    button.addEventListener("pointerenter", () => {
      button.style.background = close
        ? closeHover
        : "color-mix(in srgb, currentColor 10%, transparent)"
      if (close) button.style.color = "#ffffff"
    })
    button.addEventListener("pointerleave", () => {
      button.style.background = ""
      button.style.color = ""
    })
    caption.append(button)
  })
  return caption
}

// The preview page's stand-in for the desktop app's controls over the page: the page's root
// says it is the window's title bar, its controls on their side, as the desktop app's entry
// says. macOS's three lights are drawn at the start, on the line the page asks for, hidden when
// it asks so (as in Zen) and in full screen, where the page keeps no room for them; Windows'
// caption buttons at the end, from the page's top down to twice that line, never hidden.
// StrictMode makes a boot's backend twice and keeps the first, so making one changes nothing a
// second would undo: the buttons join the page only when it places them, in place of any other's.
export const createDemoWindowControls = (
  mode: DemoWindowControls,
  page: Document = document,
): NonNullable<Backend["windowControls"]> => {
  clearDemoWindowControls(page)
  const side = mode === "caption" ? "end" : "start"
  page.documentElement.dataset.windowControls = side
  const listeners = new Set<(inset: number) => void>()
  const drawn = mode === "caption" ? drawCaption(page) : drawLights(page, mode)
  return {
    side,
    place: (middle) => {
      if (!drawn.isConnected) {
        page.querySelectorAll("[data-demo-window-controls]").forEach((each) => each.remove())
        page.body.append(drawn)
      }
      let inset: number
      if (mode === "caption") {
        // They can't hide: a page asking for none gets them 32 pixels tall.
        drawn.style.display = "flex"
        drawn.style.height = `${2 * (middle ?? 16)}px`
        inset = captionWidth * glyphs.length
      } else {
        const shown = middle !== null && mode === "inset"
        drawn.style.display = shown ? "flex" : "none"
        if (middle !== null) drawn.style.top = `${middle - size / 2}px`
        inset = middle === null || mode === "fullScreen" ? 0 : left + width
      }
      listeners.forEach((listener) => listener(inset))
    },
    onInset: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
