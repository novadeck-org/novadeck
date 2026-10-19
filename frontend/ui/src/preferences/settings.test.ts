import { describe, expect, it } from "vitest"

import { versionText } from "./settings"

describe("the version Preferences shows", () => {
  it("is the release's version", () => {
    expect(versionText("0.4.2")).toBe("0.4.2")
    expect(versionText("1.0.0-beta.3")).toBe("1.0.0-beta.3")
  })

  it("names a build that carries 0.0.0 a development build", () => {
    expect(versionText("0.0.0")).toBe("Development build")
  })
})
