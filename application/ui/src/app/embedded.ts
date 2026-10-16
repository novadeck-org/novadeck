import { createContext, useContext } from "react"

// Whether the app runs framed in another page, as the website's hero frames the visitor
// build: the page around it says what it is and decides what a phone gets, so the app shows
// neither the visitor strip nor the narrow window's panel.
export const EmbeddedContext = createContext(false)

export const useEmbedded = (): boolean => useContext(EmbeddedContext)

// Tells the page framing the app that it is in view. The frame's `load` event fires for an
// error page as well, so the page could not otherwise tell a booted app from a failed load.
// The target origin is "*" because the message carries nothing sensitive; the framing page
// decides whom to believe by checking the origin and source of what it receives.
export const announceShown = (): void => {
  if (window.parent !== window) window.parent.postMessage({ type: "novadeck:ready" }, "*")
}

// What a framed app still holds back from the visitor, for the page's life: the wheel until
// the app is pressed in or the page engages it, and the one `novadeck:clicked` until it was
// sent or the page engaged. The app keeps one across whatever mounts the hold again
// (StrictMode's second effect run, a reboot).
export type HeldInput = { wheel: boolean; clicked: boolean }
export const heldInput = (): HeldInput => ({ wheel: true, clicked: true })

// Until the visitor engages the app, it is held in a frame its page still owns. The wheel
// belongs to that page: it is kept from everything in the app, so no canvas pans or zooms
// and no handler takes it, but never cancelled, so the browser hands the scroll on to the
// page itself, at the visitor's own pace and feel, as nothing in the app scrolls with it.
// The wheel is the app's for good once the visitor presses in it (the page may never say
// they engaged it) or the page posts `novadeck:engaged`; only the parent's message counts,
// any other sender is ignored. The first click that completes in the app is told to the page
// once, as `novadeck:clicked`, after the app's own handlers have had it, so the page can
// engage then and not before: moving the frame between press and release would send the
// click elsewhere. A tap makes a click too. Nothing is held where the app is not framed.
// Target origin is "*" for the reason `announceShown`'s is. Returns what lifts the hold, for
// the effect that began it.
const onWheel = (event: WheelEvent): void => {
  event.stopImmediatePropagation()
}

export const holdInputUntilEngaged = (held: HeldInput, frame: Window = window): (() => void) => {
  const parent = frame.parent
  if (parent === frame) return () => {}
  if (!held.wheel && !held.clicked) return () => {}
  const root = frame.document.documentElement
  const dropWheel = (): void => {
    delete root.dataset["wheelHeld"]
    frame.removeEventListener("wheel", onWheel, { capture: true })
    frame.removeEventListener("pointerdown", onPointerDown, { capture: true })
  }
  const onPointerDown = (event: PointerEvent): void => {
    // Only a primary press makes a click, which tells the page; any other leaves it be.
    if (event.button !== 0) return
    held.wheel = false
    dropWheel()
  }
  const onClick = (): void => {
    held.clicked = false
    frame.removeEventListener("click", onClick, { capture: true })
    setTimeout(() => parent.postMessage({ type: "novadeck:clicked" }, "*"), 0)
  }
  const release = (): void => {
    dropWheel()
    frame.removeEventListener("click", onClick, { capture: true })
    frame.removeEventListener("message", onMessage)
  }
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== parent) return
    const data: unknown = event.data
    if (typeof data !== "object" || data === null || !("type" in data)) return
    if (data.type !== "novadeck:engaged") return
    held.wheel = false
    held.clicked = false
    release()
  }
  // The wheel comes before the app's own, and is passive: its default, the scroll, stays.
  if (held.wheel) {
    // Marks the hold for what would scroll by the wheel inside, such as a terminal with
    // history above, so it doesn't take the page's scroll first.
    root.dataset["wheelHeld"] = ""
    frame.addEventListener("wheel", onWheel, { capture: true, passive: true })
    frame.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true })
  }
  if (held.clicked) frame.addEventListener("click", onClick, { capture: true })
  frame.addEventListener("message", onMessage)
  return release
}
