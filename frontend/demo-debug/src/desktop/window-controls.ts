import type { Backend } from "@novadeck/core/port"

// How the desktop app's window holds its own controls, as the demo plays it: set into the
// header (`inset`, macOS), the same in full screen, where they leave the page, or undefined
// for a window with its own title bar, as on Windows and Linux, or a browser.
export type DemoWindowControls = "inset" | "fullScreen"

// Where macOS draws the buttons, in CSS pixels: as apps/desktop's main/window/controls.ts
// places them at the app's normal scale.
const left = 20
const width = 54
const size = 12
const colors = ["#ff5f57", "#febc2e", "#28c840"] as const

// Takes away the buttons an earlier boot drew, and the page's word that it is the window's
// title bar.
export const clearDemoWindowControls = (page: Document = document): void => {
  page.querySelectorAll("[data-demo-window-controls]").forEach((each) => each.remove())
  delete page.documentElement.dataset.windowControls
}

// The preview page's stand-in for the desktop app's controls over the page: the page's root
// says it is the window's title bar, its controls at the start, as the desktop app's entry
// says, and three buttons are drawn where macOS puts them, on the line the page asks for,
// hidden when it asks so (as in Zen) and in full screen, where the page keeps no room for them.
// StrictMode makes a boot's backend twice and keeps the first, so making one changes nothing a
// second would undo: the buttons join the page only when it places them, in place of any other's.
export const createDemoWindowControls = (
  mode: DemoWindowControls,
  page: Document = document,
): NonNullable<Backend["windowControls"]> => {
  clearDemoWindowControls(page)
  page.documentElement.dataset.windowControls = "start"
  const listeners = new Set<(inset: number) => void>()
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
  return {
    side: "start",
    place: (middle) => {
      if (!lights.isConnected) {
        page.querySelectorAll("[data-demo-window-controls]").forEach((each) => each.remove())
        page.body.append(lights)
      }
      const shown = middle !== null && mode === "inset"
      lights.style.display = shown ? "flex" : "none"
      if (middle !== null) lights.style.top = `${middle - size / 2}px`
      const inset = middle === null || mode === "fullScreen" ? 0 : left + width
      listeners.forEach((listener) => listener(inset))
    },
    onInset: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
