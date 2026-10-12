import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { clearUpdateRaised, readUpdateRaised, writeUpdateRaised } from "./update-raised"

afterEach(() => {
  vi.restoreAllMocks()
  clearUpdateRaised()
  sessionStorage.clear()
})

describe("the offer raised in this run", () => {
  it("is read back as written, and gone once cleared", () => {
    expect(readUpdateRaised()).toBeNull()
    writeUpdateRaised("available:0.0.80")
    expect(readUpdateRaised()).toBe("available:0.0.80")
    clearUpdateRaised()
    expect(readUpdateRaised()).toBeNull()
  })

  it("is kept in memory where session storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    writeUpdateRaised("available:0.0.81")
    expect(readUpdateRaised()).toBe("available:0.0.81")
    clearUpdateRaised()
    expect(readUpdateRaised()).toBeNull()
  })
})
