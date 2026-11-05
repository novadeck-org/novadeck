import { StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"

import { CrashBoundary } from "../app/CrashBoundary"
import { applyAppearance, startingAppearance } from "../theme/apply"
import { themes } from "../theme/themes"

/** Renders an entry's app into its page, once the page has its theme. An error that stops
 * the app from drawing shows a reload, not a blank window. */
export const start = (app: ReactNode): void => {
  // The scheme attribute is on <html> before the first render.
  applyAppearance(document.documentElement, startingAppearance(window, themes))
  const root = document.getElementById("root")
  if (!root) throw new Error("Renderer root element is missing")
  createRoot(root).render(
    <StrictMode>
      <CrashBoundary>{app}</CrashBoundary>
    </StrictMode>,
  )
}
