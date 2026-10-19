import { applyAppearance } from "@novadeck/ui/theme/apply"
import { beforeEach } from "vitest"

import "@novadeck/ui/styles.css"

applyAppearance(document.documentElement, { theme: "graphite", scheme: "light" })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, "", "/")
})
