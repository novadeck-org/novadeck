import { applyAppearance } from "@novadeck/ui/theme/apply"
import { afterAll, beforeEach, inject } from "vitest"
import { page, server } from "vitest/browser"

import { platformRead } from "./support/platform"
import { toastsPassThrough } from "./support/toasts"

import "@novadeck/ui/styles.css"

applyAppearance(document.documentElement, { theme: "coolant", scheme: "light" })

const viewport = server.config.browser.viewport

// A spec file whose chords or words depend on the system (it read `isMac()`) runs as both, so
// it must be on the config's list of those; one that isn't fails here, once its specs have run.
let file: { name: string; filepath: string } | undefined
afterAll(() => {
  if (!file || !platformRead()) return
  const { name, filepath } = file
  if (!inject("eachPlatform").some((path) => filepath.endsWith(`/${path}`)))
    throw new Error(
      `${name} reads isMac(), so its specs differ on a Mac: add it to eachPlatform in ` +
        "frontend/specs/vitest.config.ts, so it runs as a Mac and as Linux in every run",
    )
})

beforeEach(async ({ task }) => {
  file = task.file
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
