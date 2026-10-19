import { describe, expect, it } from "../test"
import { maxReasonLength, reasonText } from "./install-reason"

describe("a reason from an error's text", () => {
  it("is one line without control characters", () => {
    expect(reasonText("  Failed to copy\nthe bundle\u0007. ")).toBe("Failed to copy the bundle .")
  })

  it("is cut to whole characters with an ellipsis", () => {
    const long = "😀".repeat(maxReasonLength + 5)
    const cut = Array.from(reasonText(long))
    expect(cut).toHaveLength(maxReasonLength)
    expect(cut.at(-1)).toBe("…")
    expect(reasonText("short")).toBe("short")
  })

  it("is empty for no text", () => {
    expect(reasonText(" \n")).toBe("")
  })
})
