import { cn } from "./class-name"
import { context, describe, expect, it } from "./test"

describe("class name composition", () => {
  context("when conditional utilities conflict", () => {
    it("keeps enabled values and the final Tailwind utility", () => {
      expect(cn("px-2 text-red-300", false, ["px-4", { "font-bold": true }])).toBe(
        "text-red-300 px-4 font-bold",
      )
    })
  })
})
