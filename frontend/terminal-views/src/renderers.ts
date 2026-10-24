import type { ViewMode } from "@novadeck/core/types"
import { webglRenderers, type PoolStats, type Renderers } from "@novadeck/emulator/browser"

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

// How long counts settle before they are reported: a busy minute is a few lines.
export const reportAfterMs = 10_000

const reporting = new WeakSet<Renderers>()
// Tells `report` the pool's counts, once a change has stood still for `reportAfterMs`, and
// only when they differ from the last report. Once per pool; the page's pool lives as long as
// the page.
export const reportRenderers = (
  pool: Renderers,
  report: (stats: PoolStats) => void,
  afterMs = reportAfterMs,
): void => {
  if (reporting.has(pool)) return
  reporting.add(pool)
  let last = JSON.stringify(pool.stats())
  let timer: ReturnType<typeof setTimeout> | undefined
  pool.watch(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const stats = pool.stats()
      const now = JSON.stringify(stats)
      if (now === last) return
      last = now
      report(stats)
    }, afterMs)
  })
}
