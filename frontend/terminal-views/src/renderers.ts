import type { ViewMode } from "@novadeck/core/types"
import { webglRenderers, type PoolStats, type Renderers } from "@novadeck/emulator/browser"

// Whether a view's screens draw with WebGL. Canvas zooms its windows with a CSS transform,
// which the DOM renderer's text is drawn again at but WebGL's canvas is stretched by, soft
// above one and ragged below, so Canvas keeps the DOM renderer.
export const wantsWebgl = (view: ViewMode): boolean => view !== "canvas"

let page: Renderers | undefined
let configuredCap: number | undefined

// Sets how many WebGL contexts the page's pool may hold, for a desktop app that raised
// Chromium's own limit; without it the pool takes the emulator's default, which fits the
// browser's. It must come before the pool is first made. A second call with the value already
// in use does nothing, as the backend connects again under StrictMode and on retries. A
// different value once the pool exists throws: the pool's screens already hold contexts
// counted against the old cap, and a silent keep would leave the app and the page disagreeing
// about a limit that blanks terminals when exceeded. Only code changes the value (the app's is
// fixed for its window's life), so a throw is a bug found, never a start that fails.
export const configurePageRenderers = ({ cap }: { readonly cap: number }): void => {
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new RangeError(`The WebGL cap is a whole number, 1 or more: ${cap}`)
  if (page && cap !== configuredCap)
    throw new Error(
      `The page's WebGL pool already exists with ${configuredCap ?? "the default"} contexts; it cannot take ${cap}`,
    )
  configuredCap = cap
}

// The page's pool: the context budget is the page's, whichever backend's screens draw. The app
// draws nothing else with WebGL, but its browser build can run beside an extension's canvas,
// which the pool's margin of two contexts leaves room for.
export const pageRenderers = (): Renderers =>
  (page ??= webglRenderers({
    ...(configuredCap !== undefined && { cap: configuredCap }),
  }))

// How often counts are reported while they change: a busy minute is a few lines. The first
// change starts the wait and later ones don't move it, so steady change still reports.
const reportAfterMs = 10_000

const reporting = new WeakSet<Renderers>()
// Tells `report` the pool's counts at most once per `afterMs` while they change, only when they
// differ from the last report, and at once when the page goes away (`pagehide`). Once per pool;
// the page's pool lives as long as the page.
export const reportRenderers = (
  pool: Renderers,
  report: (stats: PoolStats) => void,
  afterMs = reportAfterMs,
  target: Pick<Window, "addEventListener"> = window,
): void => {
  if (reporting.has(pool)) return
  reporting.add(pool)
  let last = JSON.stringify(pool.stats())
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = (): void => {
    clearTimeout(timer)
    timer = undefined
    const stats = pool.stats()
    const now = JSON.stringify(stats)
    if (now === last) return
    last = now
    report(stats)
  }
  pool.watch(() => {
    timer ??= setTimeout(send, afterMs)
  })
  target.addEventListener("pagehide", send)
}
