import { describe, expect, it } from "../test"
import { shouldRepoint } from "./FilePreviewHost"

const hunk = { at: 1, removed: 0, lines: ["a"], applies: true }
const work = {
  root: "/w",
  terminalId: null,
  branch: null,
  status: "added" as const,
  changedAt: 1,
  hunks: [hunk],
}

describe("a preview whose window points at an agent's copy", () => {
  const read = { works: [], renames: [] }

  it("sends the window back to the project's own file once no work lists the file", () => {
    expect(shouldRepoint({ backed: true }, read)).toBe(true)
  })

  it("leaves it while a work still does, or a rename is told, or nothing has been read", () => {
    expect(shouldRepoint({ backed: true }, { works: [work], renames: [] })).toBe(false)
    expect(
      shouldRepoint(
        { backed: true },
        { works: [], renames: [{ root: "/w", terminalId: null, branch: null, to: "b" }] },
      ),
    ).toBe(false)
    expect(shouldRepoint({ backed: true }, undefined)).toBe(false)
    expect(shouldRepoint({ backed: true }, { ...read, unavailable: "big" })).toBe(false)
  })

  it("never moves a window that shows the project's own file", () => {
    expect(shouldRepoint({ backed: false }, read)).toBe(false)
  })
})
