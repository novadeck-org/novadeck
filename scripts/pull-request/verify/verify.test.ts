import { context, describe, expect, it } from "../../test"
import { requiredSections, verifyDescription, verifyPullRequest, verifyTitle } from "./verify"

describe("pull request verification", () => {
  context("when the title follows Conventional Commits", () => {
    it.each([
      "feat: add release planning",
      "fix(api): validate responses",
      "feat!: replace storage",
      "build(deps): update Electron",
    ])("accepts %s", (title) => {
      expect(verifyTitle(title)).toEqual([])
    })

    it.each(["feature: add release planning", "feat add release planning", "feat:"])(
      "rejects %s",
      (title) => {
        expect(verifyTitle(title)).toHaveLength(1)
      },
    )
  })

  context("when required description sections are missing", () => {
    it("reports each exact heading", () => {
      expect(verifyDescription("## What\nDone", ["What", "Why", "Impact"])).toEqual([
        "Add a ## Why heading.",
        "Add a ## Impact heading.",
      ])
    })

    it("exempts only Dependabot's generated description", () => {
      expect(requiredSections("dependabot[bot]")).toEqual([])
      expect(requiredSections("contributor")).toEqual(["What", "Why", "Impact"])
      expect(verifyPullRequest("build(deps): update Electron", "", [])).toEqual({
        descriptionErrors: [],
        titleErrors: [],
      })
    })
  })

  it("reports title and description results together", () => {
    expect(verifyPullRequest("invalid", "")).toEqual({
      descriptionErrors: [
        "Add a ## What heading.",
        "Add a ## Why heading.",
        "Add a ## Impact heading.",
      ],
      titleErrors: ["Use type(optional-scope): concise imperative summary."],
    })
  })
})
