import type { UiStore } from "./ui-store"

// Keeps the UI store's `pageFocused` true while the page has the person's focus: its
// window focused and the page showing, as a minimized or hidden window's isn't. Where the
// host reports its window's focus (`windowFocus`), that is the window's focus, which holds
// while focus is inside a frame of the page, as a page in the companion pane, and ends when
// the person switches to another app. Without it the page's document says: focus moving
// into a frame blurs it first, so the check waits for that to settle. Returns the stop.
export const watchPageFocus = (
  ui: UiStore,
  view: Window,
  windowFocus?: (listener: (focused: boolean) => void) => () => void,
): (() => void) => {
  let settling: number | undefined
  // What the host last said; until it does, the document's own focus.
  let hosted: boolean | undefined
  const check = (): void => {
    const focused = hosted ?? view.document.hasFocus()
    const pageFocused = focused && view.document.visibilityState === "visible"
    ui.update((state) => (state.pageFocused === pageFocused ? state : { ...state, pageFocused }))
  }
  const blurred = (): void => {
    view.clearTimeout(settling)
    settling = view.setTimeout(check, 0)
  }
  const stopHost = windowFocus?.((focused) => {
    hosted = focused
    check()
  })
  check()
  if (!windowFocus) {
    view.addEventListener("focus", check)
    view.addEventListener("blur", blurred)
  }
  view.document.addEventListener("visibilitychange", check)
  return () => {
    stopHost?.()
    view.clearTimeout(settling)
    view.removeEventListener("focus", check)
    view.removeEventListener("blur", blurred)
    view.document.removeEventListener("visibilitychange", check)
  }
}
