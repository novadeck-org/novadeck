import { beforeEach } from "vitest"

import { applyAppearance } from "../theme/apply"

import "../styles.css"

applyAppearance(document.documentElement, { theme: "graphite", scheme: "light" })

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})
