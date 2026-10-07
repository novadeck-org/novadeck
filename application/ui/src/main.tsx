// First, so its `@layer` order statement leads the bundle.
import "./styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./app/App"
import { applyAppearance, startingAppearance } from "./theme/apply"

// The scheme attribute is on <html> before the first render.
applyAppearance(document.documentElement, startingAppearance(window))

const root = document.getElementById("root")

if (!root) throw new Error("Renderer root element is missing")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
