// First, so its `@layer` order statement leads the bundle.
import "./styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./app/App"
import { applyAppearance, startingAppearance } from "./theme/apply"
import { themes } from "./theme/themes"

// The scheme attribute is on <html> before the first render.
applyAppearance(document.documentElement, startingAppearance(window, themes))

// A visitor's page can outlive a deploy of the static site, whose files carry new hashes: a
// lazily loaded view then 404s and the app would unmount. Reloading once picks up the new
// build; the session key stops a page that keeps failing from reloading again and again.
if (import.meta.env.MODE === "try")
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

// The visitor build framed in another page, as the website's hero frames it, is addressed
// with `?embed` (see README "Visitor build").
const embedded =
  import.meta.env.MODE === "try" && new URLSearchParams(window.location.search).has("embed")

const root = document.getElementById("root")

if (!root) throw new Error("Renderer root element is missing")

createRoot(root).render(
  <StrictMode>
    <App embedded={embedded} />
  </StrictMode>,
)
