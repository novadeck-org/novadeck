import type { UiStore } from "./ui-store"

// Keeps the UI store's `pageFocused` true while the page has the person's focus: its
// window focused and the page showing, as a minimized or hidden window's isn't. Focus
// moving into a frame of the page, as a page in the companion pane, blurs the window
// first: the page still has it once that settles. Returns the stop.
export const watchPageFocus = (ui: UiStore, view: Window): (() => void) => {
  let settling: number | undefined
  const check = (): void => {
    const pageFocused = view.document.hasFocus() && view.document.visibilityState === "visible"
    ui.update((state) => (state.pageFocused === pageFocused ? state : { ...state, pageFocused }))
  }
  const blurred = (): void => {
    view.clearTimeout(settling)
    settling = view.setTimeout(check, 0)
  }
  check()
  view.addEventListener("focus", check)
  view.addEventListener("blur", blurred)
  view.document.addEventListener("visibilitychange", check)
  return () => {
    view.clearTimeout(settling)
    view.removeEventListener("focus", check)
    view.removeEventListener("blur", blurred)
    view.document.removeEventListener("visibilitychange", check)
  }
}
