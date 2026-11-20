import type { Backend } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"

import type { UiState } from "./ui-store"

// The window's own controls where they sit over the page (macOS's close, minimise and zoom
// buttons), with the header standing in for the window's title bar.

// In Zen, which hides the header, the controls hide too, and come back while the pointer is
// in the window's top-left corner: within `reach` of it to show them, and until it leaves
// `keep`, a wider corner, so they don't flicker at the edge, in CSS pixels.
export const zenCorner = {
  reach: { x: 96, y: 36 },
  keep: { x: 160, y: 72 },
} as const

// Where the controls sit in Zen while shown, where no window's header runs along the page's top
// to centre them on, in CSS pixels.
export const zenMiddle = 20

// What the controls centre on: the app's header, or in Zen the Focus window's, which then
// runs along the page's top.
const headerSelector = ".app-header"
const zenHeaderSelector = '.workspace[data-zen="true"] .focus-stage .terminal-header'

/** The box of the header, as far as the controls need it. */
export type HeaderBox = { readonly top: number; readonly height: number }

/** The middle of the Focus window's header in Zen where it runs along the page's top. */
export const alongTop = (header: HeaderBox | undefined): number | undefined =>
  header && header.top <= 1 && header.height > 0 ? header.top + header.height / 2 : undefined

/**
 * Where the controls go: centred on the header's middle while it shows; in Zen, while
 * `revealed`, on the Focus window's header where it runs along the page's top (`zenHeader`),
 * else on `zenMiddle`, and hidden (null) otherwise. Undefined where there's no header to place
 * them on yet, which leaves them where they are.
 */
export const controlsMiddle = ({
  zen,
  revealed,
  header,
  zenHeader,
}: {
  readonly zen: boolean
  readonly revealed: boolean
  readonly header: HeaderBox | undefined
  readonly zenHeader?: HeaderBox | undefined
}): number | null | undefined => {
  if (zen) {
    if (!revealed) return null
    return alongTop(zenHeader) ?? zenMiddle
  }
  if (!header || header.height <= 0) return undefined
  return header.top + header.height / 2
}

/** Whether the pointer at `x`, `y` shows the controls in Zen, where they `revealed` already. */
export const revealsInZen = (x: number, y: number, revealed: boolean): boolean => {
  const corner = revealed ? zenCorner.keep : zenCorner.reach
  return x <= corner.x && y <= corner.y
}

// The part of a window the watch reads.
type PageView = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame"
> & {
  readonly document: Pick<Document, "documentElement" | "querySelector">
}

/**
 * Keeps the window's controls on the header, where the desktop app puts them in the page: gives
 * the page the room they take (`--window-controls-inset`) and keeps them on the header's middle
 * as the page resizes. In Zen they hide, but while the pointer is in the top-left corner; there,
 * where no Focus window's header moves aside for them, the root's `data-window-controls-plate`
 * puts a plate under them, so a click meant for them never reaches what lies beneath. They hide
 * again once the pointer leaves the corner, the page, or the window loses focus. The page's root
 * says it is the window's title bar (`data-window-controls`) from the start, set by the app's
 * entry. Returns the stop.
 */
export const watchWindowControls = (
  ui: Store<UiState>,
  view: PageView,
  controls: Backend["windowControls"],
): (() => void) => {
  if (!controls) return () => {}
  const root = view.document.documentElement
  // The room the controls take, as the app last said, and whether they want a plate under
  // them: one shows only while they take room in the page, as they don't in full screen.
  let inset = 0
  let plate = false
  const showPlate = (): void => {
    if (plate && inset > 0) root.dataset.windowControlsPlate = "shown"
    else delete root.dataset.windowControlsPlate
  }
  const stopInset = controls.onInset((next) => {
    inset = next
    root.style.setProperty("--window-controls-inset", `${next}px`)
    showPlate()
  })
  let zen = Boolean(ui.getSnapshot().shell.zen)
  let revealed = false
  let placed: number | null | undefined
  let frame: number | undefined
  // Where the pointer was last seen, so leaving the page by the corner, as onto the controls
  // themselves, keeps them.
  let last = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY }
  const box = (selector: string): HeaderBox | undefined => {
    const rect = view.document.querySelector(selector)?.getBoundingClientRect()
    return rect && { top: rect.top, height: rect.height }
  }
  const place = (): void => {
    const zenHeader = zen ? box(zenHeaderSelector) : undefined
    const middle = controlsMiddle({ zen, revealed, header: box(headerSelector), zenHeader })
    plate = zen && revealed && alongTop(zenHeader) === undefined
    showPlate()
    if (middle === undefined || middle === placed) return
    placed = middle
    controls.place(middle)
  }
  const reveal = (next: boolean): void => {
    if (next === revealed) return
    revealed = next
    place()
  }
  const pointer = (event: PointerEvent): void => {
    last = { x: event.clientX, y: event.clientY }
    if (zen) reveal(revealsInZen(event.clientX, event.clientY, revealed))
  }
  const left = (): void => {
    if (!revealsInZen(last.x, last.y, false)) reveal(false)
  }
  const blurred = (): void => reveal(false)
  const stopUi = ui.subscribe(() => {
    const next = Boolean(ui.getSnapshot().shell.zen)
    if (next === zen) return
    zen = next
    revealed = false
    // The header shows or hides as React draws the change, after the store's.
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    frame = view.requestAnimationFrame(() => {
      frame = undefined
      place()
    })
  })
  view.addEventListener("resize", place)
  view.addEventListener("pointermove", pointer)
  view.addEventListener("blur", blurred)
  root.addEventListener("mouseleave", left)
  place()
  return () => {
    stopUi()
    stopInset()
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    view.removeEventListener("resize", place)
    view.removeEventListener("pointermove", pointer)
    view.removeEventListener("blur", blurred)
    root.removeEventListener("mouseleave", left)
    delete root.dataset.windowControlsPlate
    root.style.removeProperty("--window-controls-inset")
  }
}
