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
