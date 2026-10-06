import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../test"
import { rememberVariant, requestedVariant } from "./variants"

afterEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, "", "#/")
})

describe("demo variants", () => {
  context("when the address asks for one", () => {
    it("boots it", () => {
      window.history.replaceState(null, "", "#/?demo=agents")
      expect(requestedVariant()).toBe("agents")
    })
  })

  context("when the debug panel chose one", () => {
    it("boots it again after the router rewrote the address", () => {
      rememberVariant("messages")
      window.history.replaceState(null, "", "#/projects/storefront/sessions/initial/focus")
      expect(requestedVariant()).toBe("messages")
    })

    it("still yields to the address", () => {
      rememberVariant("messages")
      window.history.replaceState(null, "", "#/?demo=plain")
      expect(requestedVariant()).toBe("plain")
    })
  })

  context("when nothing asks for one", () => {
    it("boots the showcase", () => {
      expect(requestedVariant()).toBe("showcase")
    })
  })
})
