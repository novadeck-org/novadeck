import { describe, expect, it } from "vitest"

import { embeddedIn, type Address } from "./embed"

// A page at `search`, framed in another or opened on its own.
const page = (search: string, framed: boolean): Address => {
  const self: { location: { search: string }; parent: unknown } = {
    location: { search },
    parent: undefined,
  }
  self.parent = framed ? {} : self
  return self
}

describe("whether the demo is the website's frame", () => {
  it("is, framed and addressed with ?embed", () => {
    expect(embeddedIn(page("?embed", true))).toBe(true)
  })

  it("isn't, opened on its own at the frame's address, so it says the agents are simulated", () => {
    expect(embeddedIn(page("?embed", false))).toBe(false)
  })

  it("isn't, framed without ?embed", () => {
    expect(embeddedIn(page("", true))).toBe(false)
  })

  it("is, for a poster's capture, which opens the frame's still address on its own", () => {
    expect(embeddedIn(page("?embed&still", false))).toBe(true)
  })

  it("reads the page's own address and frame", () => {
    window.history.replaceState(null, "", "/?embed")
    expect(embeddedIn(window)).toBe(false)
    window.history.replaceState(null, "", "/?embed&still")
    expect(embeddedIn(window)).toBe(true)
  })
})
