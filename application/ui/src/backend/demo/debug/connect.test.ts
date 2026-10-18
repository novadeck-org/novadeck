import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../../test"
import { noTheme } from "../../terminal-views/theme"
import { requestedVariant } from "../variants"
import { createBootRehearsals } from "./boot-rehearsal"
import { connectDemo } from "./connect"

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
