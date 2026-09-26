import { beforeEach } from "vitest"

import "../styles.css"

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})
