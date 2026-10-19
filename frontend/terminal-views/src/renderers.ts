import type { ViewMode } from "@novadeck/core/types"
import { webglRenderers, type Renderers } from "@novadeck/emulator/browser"

// Whether a view's screens draw with WebGL. Canvas zooms its windows with a CSS transform,
// which the DOM renderer's text is drawn again at but WebGL's canvas is stretched by, soft
// above one and ragged below, so Canvas keeps the DOM renderer.
export const wantsWebgl = (view: ViewMode): boolean => view !== "canvas"

// The ligatures setting is one attribute on the page's root, set from Preferences.
const watchRoot = (changed: () => void): (() => void) => {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-ligatures"],
  })
  return () => observer.disconnect()
}

let page: Renderers | undefined
// The page's pool: the context budget is the page's, whichever backend's screens draw. The app
// draws nothing else with WebGL, but its browser build can run beside an extension's canvas,
// which the pool's margin of two contexts leaves room for.
export const pageRenderers = (): Renderers =>
  (page ??= webglRenderers({
    // The trade-off: ligatures render through CSS `font-variant-ligatures`, which only the
    // DOM renderer gets; WebGL draws per cell and cannot join glyphs. So every screen stays on
    // the DOM renderer while they are on (no ligatures addon for now).
    ligatures: () => document.documentElement.dataset.ligatures === "on",
    watchLigatures: watchRoot,
  }))
