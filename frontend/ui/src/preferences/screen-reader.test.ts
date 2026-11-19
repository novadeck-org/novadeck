import { context, describe, expect, it } from "../test"
import { readsToScreenReader } from "./screen-reader"

describe("readsToScreenReader", () => {
  context("on automatic", () => {
    it("reads while the app says a screen reader runs, and not otherwise", () => {
      expect(readsToScreenReader("auto", true)).toBe(true)
      expect(readsToScreenReader("auto", false)).toBe(false)
    })

    it("reads where nothing can tell, as in a browser", () => {
      expect(readsToScreenReader("auto", undefined)).toBe(true)
    })
  })

  context("set on or off", () => {
    it("follows the setting whatever the app says", () => {
      for (const running of [true, false, undefined]) {
        expect(readsToScreenReader("on", running)).toBe(true)
        expect(readsToScreenReader("off", running)).toBe(false)
      }
    })
  })
})
