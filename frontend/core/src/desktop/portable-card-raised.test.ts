import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import {
  clearPortableCardRaised,
  readPortableCardRaised,
  writePortableCardRaised,
} from "./portable-card-raised"

afterEach(() => {
  vi.restoreAllMocks()
  clearPortableCardRaised()
  localStorage.clear()
})

describe("the run the card was raised in", () => {
  it("is read back as written, and gone once cleared", () => {
    expect(readPortableCardRaised("run-1")).toBe(false)
    writePortableCardRaised("run-1")
    expect(readPortableCardRaised("run-1")).toBe(true)
    clearPortableCardRaised()
    expect(readPortableCardRaised("run-1")).toBe(false)
  })

  it("is read back by a window opened again within the run, but not by another launch", () => {
    writePortableCardRaised("run-1")
    // A window opened again has its own session storage and an empty page, not another run.
    sessionStorage.clear()
    expect(readPortableCardRaised("run-1")).toBe(true)
    expect(readPortableCardRaised("run-2")).toBe(false)
  })

  it("is replaced by the card of the next launch", () => {
    writePortableCardRaised("run-1")
    writePortableCardRaised("run-2")
    expect(readPortableCardRaised("run-1")).toBe(false)
    expect(readPortableCardRaised("run-2")).toBe(true)
  })

  it("is kept in memory where local storage throws", () => {
    for (const method of ["setItem", "getItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("blocked")
      })
    }
    writePortableCardRaised("run-1")
    expect(readPortableCardRaised("run-1")).toBe(true)
    expect(readPortableCardRaised("run-2")).toBe(false)
    clearPortableCardRaised()
    expect(readPortableCardRaised("run-1")).toBe(false)
  })
})
