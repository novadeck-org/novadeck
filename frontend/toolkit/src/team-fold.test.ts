import { rowFold } from "./team-fold"
import { describe, expect, it } from "./test"

describe("a member's row in its leads' folds", () => {
  const base = {
    folded: { "p/s": ["lead"] },
    context: "p/s",
    above: ["lead"],
    kept: false,
    underSelected: [],
    selectedAbove: [],
    preview: null,
    unfolding: null,
  }

  it("has no fold where no one leads it", () => {
    expect(rowFold({ ...base, above: [] })).toBeUndefined()
  })

  it("folds away under a folded lead, unless the person is on it or below it", () => {
    expect(rowFold(base)).toBe("away")
    expect(rowFold({ ...base, kept: true })).toBe("shown")
    expect(rowFold({ ...base, folded: {} })).toBe("shown")
  })

  it("shows a peeked lead's own team unless a lead between is folded", () => {
    // The person is on "mid", which a fold above ("lead") hides; "mid" leads this row.
    const peek = {
      ...base,
      above: ["mid", "lead"],
      underSelected: ["mid"],
      selectedAbove: ["lead"],
    }
    expect(rowFold(peek)).toBe("shown")
    expect(rowFold({ ...peek, folded: { "p/s": ["lead", "mid"] } })).toBe("away")
  })

  it("previews a fold the gutter would make, and unrolls once a lead above unfolds", () => {
    const open = { ...base, folded: {} }
    expect(rowFold({ ...open, preview: { context: "p/s", lead: "lead" } })).toBe("preview")
    expect(rowFold({ ...open, preview: { context: "p/other", lead: "lead" } })).toBe("shown")
    expect(rowFold({ ...open, kept: true, preview: { context: "p/s", lead: "lead" } })).toBe(
      "shown",
    )
    expect(rowFold({ ...open, unfolding: { context: "p/s", lead: "lead" } })).toBe("unfolding")
    // A lead already folded has nothing left to preview: its members are away.
    expect(rowFold({ ...base, kept: true, preview: { context: "p/s", lead: "lead" } })).toBe(
      "shown",
    )
  })
})
