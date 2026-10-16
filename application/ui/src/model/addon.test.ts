import { describe, expect, it } from "vitest"

import { refusalText } from "./addon"

describe("what a refused call says", () => {
  it("names the call, and the addon it was of", () => {
    expect(refusalText({ call: "install", message: "Busy." }, "voice input")).toBe(
      "Couldn't install voice input: Busy.",
    )
    expect(refusalText({ call: "set", message: "Not installed." }, "Murmur")).toBe(
      "Couldn't change Murmur: Not installed.",
    )
    expect(refusalText({ call: "cancel", message: "Gone." }, "Murmur")).toBe(
      "Couldn't cancel the install: Gone.",
    )
    expect(refusalText({ call: "uninstall", message: "Disk busy." }, "voice input")).toBe(
      "Couldn't uninstall voice input: Disk busy.",
    )
  })
})
