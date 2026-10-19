import { requestedVariant } from "@novadeck/demo/variants"
import { noTheme } from "@novadeck/terminal-views/theme"
import { afterEach } from "vitest"

import { createBootRehearsals } from "./boot-rehearsal"
import { connectDemo } from "./connect"
import { context, describe, expect, it } from "./test"

afterEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, "", "#/")
})

describe("demo connection", () => {
  context("when the address asks for a variant", () => {
    it("keeps it for the tab, so a reload after the router rewrote the address boots it", () => {
      window.history.replaceState(null, "", "#/?demo=plain")
      connectDemo(createBootRehearsals(), noTheme)
      window.history.replaceState(null, "", "#/projects/storefront/sessions/initial/focus")
      expect(requestedVariant()).toBe("plain")
    })
  })
})
