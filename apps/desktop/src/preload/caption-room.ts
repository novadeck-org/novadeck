// The room Windows' caption buttons take at the page's top-right, as the page itself measures
// it: the window controls overlay's title bar area ends where the buttons start. The main
// process's figure (three 46-point buttons) stands until the page can measure, as Electron's
// buttons follow the system's metrics, which differ between Windows versions and scales.

/** Chromium's window controls overlay, which TypeScript's DOM types don't have yet. */
export type ControlsOverlay = {
  readonly visible: boolean
  getTitlebarAreaRect(): { readonly x: number; readonly width: number }
  addEventListener(type: "geometrychange", listener: () => void): void
  removeEventListener(type: "geometrychange", listener: () => void): void
}

/** The part of a page the measure reads: its width and its window controls overlay. */
export type CaptionView = {
  readonly innerWidth: number
  readonly navigator: { readonly windowControlsOverlay?: ControlsOverlay | undefined }
}

/** `view` as the measure reads it, its overlay where the browser has one. */
export const captionView = (view: Window): CaptionView => ({
  get innerWidth() {
    return view.innerWidth
  },
  navigator: view.navigator as Navigator & { windowControlsOverlay?: ControlsOverlay },
})

/** The room the buttons take, in CSS pixels, as the page measures it; undefined if it can't. */
export const measuredRoom = (view: CaptionView): number | undefined => {
  const overlay = view.navigator.windowControlsOverlay
  if (!overlay?.visible) return undefined
  const area = overlay.getTitlebarAreaRect()
  const room = view.innerWidth - (area.x + area.width)
  return Number.isFinite(room) && room > 0 ? Math.ceil(room) : undefined
}

/**
 * Passes the main process's room for the buttons on to `listener`, measured by the page where it
 * can (0, the buttons left out as in full screen, passes as it is), and again whenever the
 * overlay's geometry changes. The larger of the two stands, so a measure that misses the app's
 * scale never lets the header run under the buttons. Returns the relay for each of the main
 * process's reports and the stop.
 */
export const relayCaptionRoom = (
  view: CaptionView,
  listener: (inset: number) => void,
): { readonly report: (inset: number) => void; readonly stop: () => void } => {
  let last: number | undefined
  const tell = (): void => {
    if (last === undefined) return
    listener(last > 0 ? Math.max(measuredRoom(view) ?? 0, last) : last)
  }
  const overlay = view.navigator.windowControlsOverlay
  overlay?.addEventListener("geometrychange", tell)
  return {
    report: (inset) => {
      last = inset
      tell()
    },
    stop: () => overlay?.removeEventListener("geometrychange", tell),
  }
}
