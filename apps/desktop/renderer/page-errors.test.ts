import { describe, expect, it } from "../src/test"
import { pageError } from "./page-errors"

describe("pageError", () => {
  it("tells of an Error by its name, message and stack", () => {
    const error = new TypeError("x is undefined")
    expect(pageError("error", error)).toEqual({
      kind: "error",
      name: "TypeError",
      message: "x is undefined",
      stack: error.stack,
    })
  })

  it("tells of anything else thrown by its type alone", () => {
    expect(pageError("rejection", "what the person typed")).toEqual({
      kind: "rejection",
      name: "string",
      message: "A non-Error was thrown",
    })
  })

  it("tells of an error event without its error by the event's message", () => {
    expect(pageError("error", null, "Script error.")).toEqual({
      kind: "error",
      name: "Error",
      message: "Script error.",
    })
  })
})
