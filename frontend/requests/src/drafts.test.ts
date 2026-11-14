import { drafted } from "./drafts"
import { describe, expect, it } from "./test"

describe("A dialog's draft", () => {
  it("holds nothing until the person puts something in", () => {
    expect(drafted(undefined)).toBe(false)
    expect(drafted({})).toBe(false)
    expect(drafted({ page: 2, typed: { no: "  " }, picks: {}, entries: {} })).toBe(false)
  })

  it("holds words typed into an option, a pick or words on a question, or a form's entry", () => {
    expect(drafted({ typed: { no: "Use npm." } })).toBe(true)
    expect(drafted({ picks: { q: { options: ["a"], text: "" } } })).toBe(true)
    expect(drafted({ picks: { q: { options: [], text: "Neither" } } })).toBe(true)
    expect(drafted({ entries: { target: { kind: "text", value: "web" } } })).toBe(true)
  })
})
