// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { BackendSelection } from "@novadeck/core/port"
import { App } from "@novadeck/ui/app/App"
import { start } from "@novadeck/ui/entries/start"
import { pageTheme } from "@novadeck/ui/theme/source"

// The visitor build, for a website: the demo without its debug panel, loaded with the
// connection, so no other build carries it.
const visitor: BackendSelection = {
  connect: async (signal, progress) =>
    (await import("@novadeck/demo/visitor/connect")).connectVisitor(signal, progress, {
      theme: pageTheme,
    }),
}

// A visitor's page can outlive a deploy of the static site, whose files carry new hashes: a
// lazily loaded view then 404s and the app would unmount. Reloading once picks up the new
// build; the session key stops a page that keeps failing from reloading again and again.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (window.sessionStorage.getItem("novadeck:try-reloaded")) return
    window.sessionStorage.setItem("novadeck:try-reloaded", "1")
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

// Framed in another page, as the website's hero frames it, the demo is addressed with
// `?embed` (see README "Visitor build"): read here once, and nowhere else.
const embedded = new URLSearchParams(window.location.search).has("embed")

start(<App selection={visitor} embedded={embedded} />)
