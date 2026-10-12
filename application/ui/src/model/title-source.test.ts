import { describe, expect, it } from "../test"
import { MURMUR_NAME } from "./murmur"
import { sameTitleSource, titleSourceText } from "./title-source"

describe("who a terminal's name is from", () => {
  it("says the person, the agent's terminal, murmur or the default", () => {
    expect(titleSourceText({ kind: "person" })).toBe("Named by you")
    expect(titleSourceText({ kind: "agent", by: "t2" })).toBe("Named by the agent in t2")
    expect(titleSourceText({ kind: "murmur" })).toBe(`Named by ${MURMUR_NAME}`)
    expect(titleSourceText({ kind: "default" })).toBe("Default name")
  })
})

describe("whether two names are from the same source", () => {
  it("compares the kind, and for an agent its terminal", () => {
    expect(sameTitleSource({ kind: "murmur" }, { kind: "murmur" })).toBe(true)
    expect(sameTitleSource({ kind: "murmur" }, { kind: "default" })).toBe(false)
    expect(sameTitleSource({ kind: "agent", by: "t1" }, { kind: "agent", by: "t2" })).toBe(false)
    expect(sameTitleSource({ kind: "agent", by: "t1" }, { kind: "agent", by: "t1" })).toBe(true)
  })
})
