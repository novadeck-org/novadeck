import { context, describe, expect, it } from "../../../test"
import { studioAgent, authAgent } from "./agents"
import authV1 from "./plans/auth-v1.md?raw"
import authV2 from "./plans/auth-v2.md?raw"
import studioV1 from "./plans/studio-v1.md?raw"
import studioV2 from "./plans/studio-v2.md?raw"
import { applyEdits, removeNotes } from "./revise"

describe("sample agents revising their plans", () => {
  it("turn their first plan into the next", () => {
    expect(applyEdits(studioV1, studioAgent.revisions[0]!)).toBe(studioV2)
    expect(applyEdits(authV1, authAgent.revisions[0]!)).toBe(authV2)
  })

  context("over the user's edits", () => {
    it("keep the user's other lines, and the notes on the lines they rewrite", () => {
      const edited = studioV1
        .replace("and deployment.", "and deployment. No blog.")
        .replace("warm ivory background.", "warm ivory background. <!-- novadeck: Keep serif? -->")
      const revised = applyEdits(edited, studioAgent.revisions[0]!)
      expect(revised).toContain("No blog.")
      expect(revised).toContain("confident grotesk")
      expect(revised).toContain("<!-- novadeck: Keep serif? -->")
    })

    it("keep a note in the middle of a line they rewrite", () => {
      expect(applyEdits("A <!-- novadeck: x --> B\n", [{ line: "A B", with: "A2 B" }])).toBe(
        "A2 B <!-- novadeck: x -->\n",
      )
    })

    it("keep the file's line breaks", () => {
      const crlf = studioV1.replaceAll("\n", "\r\n")
      expect(applyEdits(crlf, studioAgent.revisions[0]!)).toBe(studioV2.replaceAll("\n", "\r\n"))
    })
  })

  context("applying the user's notes", () => {
    it("remove each, with its line when it had one to itself", () => {
      expect(
        removeNotes("A <!-- novadeck: x -->\n<!-- novadeck: y -->\n  <!-- novadeck: z -->\nB"),
      ).toBe("A\nB")
    })
  })
})
