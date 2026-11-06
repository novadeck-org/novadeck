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
      expect(requiredSections("contributor")).toEqual(["What", "Why", "Impact", "Heads-up"])
      expect(verifyPullRequest("build(deps): update Electron", "", [])).toEqual({
        descriptionErrors: [],
        titleErrors: [],
      })
    })
  })

  it("wants the Heads-up answered, if only with None", () => {
    const sections = ["Heads-up"]
    const unanswered = ["Say what works differently under ## Heads-up, or write None."]
    expect(verifyDescription("## Heads-up\n\nNone\n", sections)).toEqual([])
    expect(
      verifyDescription("## Heads-up\n\nThe button moved.\n\n## Screenshot\n", sections),
    ).toEqual([])
    expect(verifyDescription("## Heads-up\r\n\r\nNone\r\n", sections)).toEqual([])
    expect(verifyDescription("## Heads-up\n\n<!-- Would someone... -->\n", sections)).toEqual(
      unanswered,
    )
    expect(verifyDescription("## Heads-up\n\n## Screenshot\n\nA picture.\n", sections)).toEqual(
      unanswered,
    )
  })

  it("reports title and description results together", () => {
    expect(verifyPullRequest("invalid", "")).toEqual({
      descriptionErrors: [
        "Add a ## What heading.",
        "Add a ## Why heading.",
        "Add a ## Impact heading.",
        "Add a ## Heads-up heading.",
      ],
      titleErrors: ["Use type(optional-scope): concise imperative summary."],
    })
  })
})
