import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { clearUpdateRaised, readUpdateRaised, writeUpdateRaised } from "./update-raised"

afterEach(() => {
  vi.restoreAllMocks()
  clearUpdateRaised()
  localStorage.clear()
})

describe("the offer raised in this run", () => {
  it("is read back as written, and gone once cleared", () => {
    expect(readUpdateRaised("run-1")).toBeNull()
    writeUpdateRaised("run-1", "available:0.0.80")
    expect(readUpdateRaised("run-1")).toBe("available:0.0.80")
    clearUpdateRaised()
    expect(readUpdateRaised("run-1")).toBeNull()
  })

  it("is read back by a window opened again within the run, but not by another launch", () => {
    writeUpdateRaised("run-1", "available:0.0.80")
    // A window opened again has its own session storage and an empty page, not another run.
    sessionStorage.clear()
    expect(readUpdateRaised("run-1")).toBe("available:0.0.80")
    expect(readUpdateRaised("run-2")).toBeNull()
  })

  it("is replaced by the notice of the next launch", () => {
    writeUpdateRaised("run-1", "available:0.0.80")
    writeUpdateRaised("run-2", "available:0.0.81")
    expect(readUpdateRaised("run-1")).toBeNull()
    expect(readUpdateRaised("run-2")).toBe("available:0.0.81")
  })

  it("is nothing where the stored text is damaged", () => {
    for (const text of ["", "{", "null", '"a"', '{"run":"run-1"}', '{"run":1,"key":"a"}']) {
      localStorage.setItem("novadeck.update-raised", text)
      expect(readUpdateRaised("run-1")).toBeNull()
    }
  })

  it("is kept in memory where local storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    writeUpdateRaised("run-1", "available:0.0.81")
    expect(readUpdateRaised("run-1")).toBe("available:0.0.81")
    expect(readUpdateRaised("run-2")).toBeNull()
    clearUpdateRaised()
    expect(readUpdateRaised("run-1")).toBeNull()
  })
})
