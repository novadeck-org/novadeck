import { applyAppearance } from "@novadeck/ui/theme/apply"
import { beforeEach } from "vitest"
import { page, server } from "vitest/browser"

import { toastsPassThrough } from "./support/toasts"

import "@novadeck/ui/styles.css"

applyAppearance(document.documentElement, { theme: "coolant", scheme: "light" })

const viewport = server.config.browser.viewport

beforeEach(async () => {
  // A spec that resizes the page puts it back: one that doesn't would run every spec after it in
  // its file at its size, but only when the file runs whole. The page goes back to size and the
  // spec after it fails here, naming the cause, so the rest of the file runs as it would alone.
  const { innerWidth: width, innerHeight: height } = window
  if (width !== viewport.width || height !== viewport.height) {
    await page.viewport(viewport.width, viewport.height)
    throw new Error(
      `The last spec left the page at ${width}x${height}, not ${viewport.width}x${viewport.height}: ` +
        "restore it with onTestFinished(() => page.viewport(...)) where it resizes",
    )
  }
  // The last spec's app unmounts first: until then it is live, and its effects and its unmount
  // can write to storage, which the clear below must not leave for this spec to read. Loaded
  // here, not at the top: react-dom must load after the counter run's render probe, which a
  // spec file installs as it loads (the `pure` entry adds no hooks of its own).
  const { cleanup } = await import("vitest-browser-react/pure")
  await cleanup()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, "", "/")
  // Toasts that land mid-spec don't take its presses (support/toasts.tsx).
  toastsPassThrough()
})
