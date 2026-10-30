import type { UiStore } from "./ui-store"

// The part of a window the watch reads.
type PageView = Pick<
  Window,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
> & {
  readonly document: Pick<
    Document,
    "hasFocus" | "visibilityState" | "addEventListener" | "removeEventListener"
  >
}

// Keeps the UI store's `pageFocused` true while the page has the person's focus: its
// window focused and the page showing, as a minimized or hidden window's isn't. Where the
// desktop app reports its window's focus (`windowFocus`), that is the window's focus, which
// holds while focus is inside a frame of the page, as a page in the companion pane, and ends
// when the person switches to another app. Without it the page's document says: focus moving
// into a frame blurs it first, so the check waits for that to settle. Returns the stop.
export const watchPageFocus = (
  ui: UiStore,
  view: PageView,
  windowFocus?: (listener: (focused: boolean) => void) => () => void,
): (() => void) => {
  let settling: number | undefined
  // What the desktop app last said; until it does, the document's own focus.
  let reported: boolean | undefined
  const check = (): void => {
    const focused = reported ?? view.document.hasFocus()
    const pageFocused = focused && view.document.visibilityState === "visible"
    ui.update((state) => (state.pageFocused === pageFocused ? state : { ...state, pageFocused }))
  }
  const blurred = (): void => {
    view.clearTimeout(settling)
    settling = view.setTimeout(check, 0)
  }
  const stopWindowFocus = windowFocus?.((focused) => {
    reported = focused
    check()
  })
  check()
  if (!windowFocus) {
    view.addEventListener("focus", check)
    view.addEventListener("blur", blurred)
  }
  view.document.addEventListener("visibilitychange", check)
  return () => {
    stopWindowFocus?.()
    view.clearTimeout(settling)
    view.removeEventListener("focus", check)
    view.removeEventListener("blur", blurred)
    view.document.removeEventListener("visibilitychange", check)
  }
}
