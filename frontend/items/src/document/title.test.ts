import { describe, expect, it } from "../test"
import { titleOf } from "./title"

describe("a document's title", () => {
  it("is its first top-level heading", () => {
    expect(titleOf("docs/notes.md", "Intro\n\n# Notes\n\n## More")).toBe("Notes")
  })

  it("is its file's name without one", () => {
    expect(titleOf("/repo/docs/notes.md", "No heading")).toBe("notes.md")
  })

  it("is its file's name from a Windows path", () => {
    expect(titleOf("C:\\repo\\docs\\notes.md", "No heading")).toBe("notes.md")
  })
})
