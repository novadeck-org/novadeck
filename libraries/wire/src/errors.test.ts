import { ORPCError } from "@orpc/client"
import { describe, expect, it } from "vitest"

import { hasCode, normalize, WireError } from "./errors.js"

describe("normalize", () => {
  it("turns an oRPC error into a wire error with its code, message and data", () => {
    const cause = new ORPCError("CONFLICT", { message: "Taken.", data: { reason: "busy" } })
    const error = normalize(cause)
    expect(error).toBeInstanceOf(WireError)
    expect(error).toMatchObject({
      name: "WireError",
      code: "CONFLICT",
      message: "Taken.",
      data: { reason: "busy" },
      cause,
    })
  })

  it("passes anything else through", () => {
    const fault = new TypeError("local")
    expect(normalize(fault)).toBe(fault)
  })
})

describe("hasCode", () => {
  it("matches a wire error by any of its codes", () => {
    const error = new WireError("DISCONNECTED")
    expect(hasCode(error, "CLOSED", "DISCONNECTED")).toBe(true)
    expect(hasCode(error, "CLOSED")).toBe(false)
  })

  it("matches nothing but wire errors", () => {
    expect(hasCode(Object.assign(new Error("x"), { code: "CLOSED" }), "CLOSED")).toBe(false)
    expect(hasCode(new ORPCError("CLOSED"), "CLOSED")).toBe(false)
  })
})
